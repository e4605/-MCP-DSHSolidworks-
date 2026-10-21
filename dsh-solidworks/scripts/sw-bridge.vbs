' SolidWorks COM bridge for the DSH SolidWorks plugin.
' Pure-ASCII VBScript run by cscript //U (UTF-16LE stdout); one short-lived
' process per tool call. All human-readable text is rendered on the Node side;
' this script only returns structured JSON data.
Option Explicit
On Error Resume Next

Dim gLaunched : gLaunched = False
Dim A : A = WScript.Arguments.Named.Item("A")
Dim gOutFile : gOutFile = WScript.Arguments.Named.Item("OutFile")

' ---- argument helpers ----------------------------------------------------

Function NV(name, dflt)
  If WScript.Arguments.Named.Exists(name) Then
    NV = WScript.Arguments.Named.Item(name)
  Else
    NV = dflt
  End If
End Function

Function J(s)
  Dim v : v = CStr(s)
  v = Replace(v, "\", "\\")
  v = Replace(v, Chr(34), "\" & Chr(34))
  v = Replace(v, Chr(10), "\n")
  v = Replace(v, Chr(13), "\r")
  J = Chr(34) & v & Chr(34)
End Function

' The JSON payload is written to a UTF-8 file so console/codepage encoding
' never touches it; stdout only carries an ASCII marker line.
Sub WriteBridgeResult(json)
  If Len(gOutFile) = 0 Then
    WScript.Echo json
    Exit Sub
  End If
  Dim stream
  Set stream = CreateObject("ADODB.Stream")
  stream.Type = 2
  stream.Charset = "utf-8"
  stream.Open
  stream.WriteText json
  stream.SaveToFile gOutFile, 2
  stream.Close
  WScript.Echo "RESULT:" & gOutFile
End Sub

Sub OutOK(data)
  WriteBridgeResult "{""ok"":true,""code"":""OK"",""data"":{" & data & "}}"
  WScript.Quit 0
End Sub

Sub OutFail(code, detail)
  WriteBridgeResult "{""ok"":false,""code"":" & J(code) & ",""detail"":" & J(detail) & "}"
  WScript.Quit 1
End Sub

' ---- SolidWorks plumbing -------------------------------------------------

Function WaitReady(app, secs)
  Dim deadline : deadline = DateAdd("s", secs, Now)
  Dim v, ok
  ok = False
  Do While Now < deadline
    v = app.RevisionNumber
    If Err.Number = 0 Then
      If Len(CStr(v)) > 0 Then ok = True : Exit Do
    Else
      Err.Clear
    End If
    WScript.Sleep 2000
  Loop
  WaitReady = ok
End Function

Function TryAttach(ByRef app)
  On Error Resume Next
  Set app = Nothing
  Set app = GetObject(, "SldWorks.Application")
  If Err.Number <> 0 Then Err.Clear : TryAttach = False Else TryAttach = True
End Function

Function TryCreate(ByRef app)
  On Error Resume Next
  Set app = Nothing
  Set app = CreateObject("SldWorks.Application")
  If Err.Number <> 0 Then Err.Clear : TryCreate = False Else TryCreate = True
End Function

Function GetSwApp()
  Dim app : Set app = Nothing
  If TryAttach(app) Then
    If Not WaitReady(app, 45) Then OutFail "SW_STARTING", "SolidWorks is busy (starting or showing a dialog)"
    Set GetSwApp = app
    Exit Function
  End If
  If NV("AutoLaunch", "1") = "0" Then OutFail "SW_NOT_RUNNING", "SolidWorks is not running and auto launch is disabled"
  gLaunched = True
  If Not TryCreate(app) Then OutFail "SW_LAUNCH_FAILED", "SolidWorks failed to launch (check license and installation)"
  Dim deadline : deadline = DateAdd("s", 60, Now)
  Do While Now < deadline
    Dim att : Set att = Nothing
    If TryAttach(att) Then
      Set app = att
      Exit Do
    End If
    WScript.Sleep 3000
  Loop
  ' Never touch other automation members until SolidWorks answers.
  If Not WaitReady(app, 60) Then OutFail "SW_STARTING", "SolidWorks is still starting up"
  Set GetSwApp = app
End Function

Function GetDoc(app)
  Dim d : Set d = Nothing
  Set d = app.ActiveDoc
  If d Is Nothing Then OutFail "SW_NO_DOC", "no SolidWorks document is open"
  Set GetDoc = d
End Function

Function SetUnits(app)
  If NV("SetUnits", "1") = "0" Then SetUnits = "keep" : Exit Function
  app.SetUserPreferenceIntegerValue 105, 0
  If Err.Number <> 0 Then Err.Clear : SetUnits = "unknown" : Exit Function
  If app.GetUserPreferenceIntegerValue(105) = 0 Then SetUnits = "MMGS" Else SetUnits = "unknown"
End Function

Function ParseVersion(n)
  Dim m : m = Trim(Replace(UCase(n), "SOLIDWORKS", ""))
  If IsNumeric(m) Then ParseVersion = CLng(m) Else ParseVersion = 0
End Function

Function FindPartTemplate(app)
  Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")
  Dim t : t = ""
  app.GetUserPreferenceStringValue 74
  If Err.Number = 0 Then
    t = CStr(app.GetUserPreferenceStringValue(74))
    Err.Clear
    If fso.FileExists(t) Then FindPartTemplate = t : Exit Function
  Else
    Err.Clear
  End If
  If fso.FolderExists("C:\ProgramData\SolidWorks") Then
    Dim base, subF, tdir, f, best, bestNum, num
    Set base = fso.GetFolder("C:\ProgramData\SolidWorks")
    best = "" : bestNum = -1
    For Each subF In base.SubFolders
      tdir = subF.Path & "\templates"
      If fso.FolderExists(tdir) Then
        num = ParseVersion(subF.Name)
        If num > bestNum Then
          For Each f In fso.GetFolder(tdir).Files
            If LCase(fso.GetExtensionName(f.Name)) = "prtdot" Then
              best = f.Path : bestNum = num
              If InStr(1, LCase(f.Name), "part") > 0 Then FindPartTemplate = f.Path : Exit Function
            End If
          Next
        End If
      End If
    Next
    If Len(best) > 0 Then FindPartTemplate = best : Exit Function
  End If
  OutFail "SW_NO_TEMPLATE", "no part template found (check Options > Default Templates)"
End Function

' Rebuild and scan every feature; returns a JSON fragment.
Function FeatureStatus(doc)
  If NV("AutoRebuildCheck", "1") = "0" Then
    FeatureStatus = """rebuildOk"":null,""featureCount"":null,""featureErrors"":[],""clean"":null"
    Exit Function
  End If
  Dim rb : rb = False
  Dim r : r = doc.EditRebuild3
  If Err.Number = 0 Then rb = CBool(r) Else Err.Clear
  Dim cnt : cnt = 0
  Dim errs : errs = ""
  Dim feat : Set feat = Nothing
  Set feat = doc.FirstFeature
  Do While Not feat Is Nothing
    cnt = cnt + 1
    Dim code : code = feat.GetErrorCode
    If Err.Number <> 0 Then
      Err.Clear
    ElseIf code <> 0 Then
      Dim fname : fname = feat.Name
      Dim ftype : ftype = feat.GetTypeName2
      If Err.Number <> 0 Then Err.Clear : ftype = ""
      errs = errs & J(fname & " (" & ftype & ")") & ","
    End If
    Set feat = feat.GetNextFeature
    If Err.Number <> 0 Then Err.Clear : Set feat = Nothing
  Loop
  If Len(errs) > 0 Then errs = Left(errs, Len(errs) - 1)
  Dim clean : clean = False
  If rb And Len(errs) = 0 Then clean = True
  FeatureStatus = """rebuildOk"":" & LCase(CStr(rb)) & ",""featureCount"":" & cnt & ",""featureErrors"":[" & errs & "],""clean"":" & LCase(CStr(clean))
End Function

' Leave any active sketch, select the plane, start a new sketch on it.
Sub StartSketch(doc, plane)
  Dim active : Set active = Nothing
  Set active = doc.SketchManager.ActiveSketch
  If Not active Is Nothing Then doc.SketchManager.InsertSketch False
  Err.Clear
  Dim idx : idx = 0
  If plane = "top" Then idx = 1
  If plane = "right" Then idx = 2
  Dim feat, n
  Set feat = Nothing
  Set feat = doc.FirstFeature
  n = 0
  Do While Not feat Is Nothing
    If feat.GetTypeName2 = "RefPlane" Then
      If n = idx Then Exit Do
      n = n + 1
    End If
    Set feat = feat.GetNextFeature
    If Err.Number <> 0 Then Err.Clear : Set feat = Nothing
  Loop
  If feat Is Nothing Then OutFail "SW_NO_PLANES", "reference planes not found"
  feat.Select2 False, 0
  If Err.Number <> 0 Then Err.Clear
  doc.SketchManager.InsertSketch True
End Sub

' Select every solid-producing feature. In SW, a selected feature stands for
' all of its edges, which is exactly what FeatureFillet/FeatureChamfer need.
Function SelectSolidFeatures(doc)
  Dim fcnt : fcnt = 0
  Dim feat : Set feat = Nothing
  Set feat = doc.FirstFeature
  Do While Not feat Is Nothing
    Dim t : t = feat.GetTypeName2
    If Err.Number <> 0 Then
      Err.Clear
      t = ""
    End If
    If InStr(t, "Extru") > 0 Or InStr(t, "Revol") > 0 Or InStr(t, "Sweep") > 0 Or InStr(t, "Loft") > 0 Then
      feat.Select2 True, 0
      If Err.Number = 0 Then fcnt = fcnt + 1
      Err.Clear
    End If
    Set feat = feat.GetNextFeature
    If Err.Number <> 0 Then Err.Clear : Set feat = Nothing
  Loop
  If fcnt = 0 Then OutFail "SW_NO_EDGES", "no solid features could be selected (create an extrusion first)"
  SelectSolidFeatures = fcnt
End Function

Sub EnsureDir(fso, p)
  If Len(p) = 0 Then Exit Sub
  If fso.FolderExists(p) Then Exit Sub
  EnsureDir fso, fso.GetParentFolderName(p)
  If Not fso.FolderExists(p) Then fso.CreateFolder p
End Sub

' ---- actions -------------------------------------------------------------

Sub DoConnect()
  Dim app : Set app = GetSwApp()
  Dim vis : vis = False
  If NV("ShowWindow", "1") = "1" Then
    app.Visible = True
    If Err.Number = 0 Then vis = True Else Err.Clear
  End If
  Dim ver : ver = ""
  ver = app.RevisionNumber
  If Err.Number <> 0 Then Err.Clear : ver = ""
  Dim units : units = SetUnits(app)
  Dim title : title = ""
  Dim d : Set d = Nothing
  Set d = app.ActiveDoc
  If Not d Is Nothing Then title = d.GetTitle
  OutOK """connected"":true,""launched"":" & LCase(CStr(gLaunched)) & ",""visible"":" & LCase(CStr(vis)) & ",""version"":" & J(ver) & ",""units"":" & J(units) & ",""activeDocTitle"":" & J(title)
End Sub

Sub DoNewPart()
  Dim app : Set app = GetSwApp()
  Dim t : t = FindPartTemplate(app)
  Dim doc : Set doc = Nothing
  Set doc = app.NewDocument(t, 0, 0, 0)
  If doc Is Nothing Then OutFail "SW_NEW_DOC_FAILED", "NewDocument returned nothing (template may be corrupt)"
  Dim units : units = SetUnits(app)
  Dim title : title = ""
  title = doc.GetTitle
  If Err.Number <> 0 Then Err.Clear : title = ""
  OutOK """title"":" & J(title) & ",""units"":" & J(units)
End Sub

Sub DoDrawSketch()
  Dim app : Set app = GetSwApp()
  Dim doc : Set doc = GetDoc(app)
  Dim plane : plane = LCase(NV("Plane", "front"))
  Dim shape : shape = LCase(NV("Shape", ""))
  Dim append : append = (NV("Append", "0") = "1")
  If plane <> "front" And plane <> "top" And plane <> "right" Then OutFail "SW_BAD_PARAMS", "invalid plane: " & plane
  If shape <> "rectangle" And shape <> "circle" And shape <> "polygon" And shape <> "arc" And shape <> "ellipse" And shape <> "polyline" And shape <> "centerline" Then OutFail "SW_BAD_PARAMS", "invalid shape: " & shape
  If append Then
    Dim active : Set active = Nothing
    Set active = doc.SketchManager.ActiveSketch
    If active Is Nothing Then OutFail "SW_NO_SKETCH", "no active sketch to append to"
  Else
    StartSketch doc, plane
  End If
  Dim cx, cy
  cx = 0 : cy = 0
  If Len(NV("Center_x", "")) > 0 Then cx = CDbl(NV("Center_x", "")) / 1000
  If Len(NV("Center_y", "")) > 0 Then cy = CDbl(NV("Center_y", "")) / 1000
  Dim seg : Set seg = Nothing
  If shape = "circle" Then
    Set seg = doc.SketchManager.CreateCircleByRadius(CDbl(cx), CDbl(cy), CDbl(0), CDbl(CDbl(NV("Diameter", "0")) / 2000))
  ElseIf shape = "rectangle" Then
    Dim w, h, x1, y1, x2, y2, s2, s3, s4
    w = CDbl(NV("Width", "0")) / 1000
    h = CDbl(NV("Height", "0")) / 1000
    x1 = cx - w / 2 : y1 = cy - h / 2 : x2 = cx + w / 2 : y2 = cy + h / 2
    Set seg = doc.SketchManager.CreateLine(CDbl(x1), CDbl(y1), CDbl(0), CDbl(x2), CDbl(y1), CDbl(0))
    If seg Is Nothing Then OutFail "SW_SKETCH_FAILED", "rectangle line 1 failed (err " & Err.Number & ": " & Err.Description & ")"
    Set s2 = Nothing
    Set s2 = doc.SketchManager.CreateLine(CDbl(x2), CDbl(y1), CDbl(0), CDbl(x2), CDbl(y2), CDbl(0))
    If s2 Is Nothing Then OutFail "SW_SKETCH_FAILED", "rectangle line 2 failed (err " & Err.Number & ": " & Err.Description & ")"
    Set s3 = Nothing
    Set s3 = doc.SketchManager.CreateLine(CDbl(x2), CDbl(y2), CDbl(0), CDbl(x1), CDbl(y2), CDbl(0))
    If s3 Is Nothing Then OutFail "SW_SKETCH_FAILED", "rectangle line 3 failed (err " & Err.Number & ": " & Err.Description & ")"
    Set s4 = Nothing
    Set s4 = doc.SketchManager.CreateLine(CDbl(x1), CDbl(y2), CDbl(0), CDbl(x1), CDbl(y1), CDbl(0))
    If s4 Is Nothing Then OutFail "SW_SKETCH_FAILED", "rectangle line 4 failed (err " & Err.Number & ": " & Err.Description & ")"
  ElseIf shape = "polygon" Then
    Dim r : r = CDbl(NV("Diameter", "0")) / 2000
    Dim sides : sides = CInt(NV("Sides", "6"))
    Dim i, ang1, ang2, px1, py1, px2, py2
    Dim pi : pi = 4 * Atn(1)
    For i = 0 To sides - 1
      ang1 = i * 2 * pi / sides
      ang2 = (i + 1) * 2 * pi / sides
      px1 = cx + r * Cos(ang1) : py1 = cy + r * Sin(ang1)
      px2 = cx + r * Cos(ang2) : py2 = cy + r * Sin(ang2)
      Set seg = Nothing
      Set seg = doc.SketchManager.CreateLine(CDbl(px1), CDbl(py1), CDbl(0), CDbl(px2), CDbl(py2), CDbl(0))
      If seg Is Nothing Then OutFail "SW_SKETCH_FAILED", "polygon line failed (err " & Err.Number & ": " & Err.Description & ")"
    Next
  ElseIf shape = "arc" Then
    Dim startDeg : startDeg = CDbl(NV("Start_angle", "0"))
    Dim endDeg : endDeg = CDbl(NV("End_angle", "180"))
    Dim arcR : arcR = CDbl(NV("Diameter", "0")) / 2000
    Dim a1, a2, sx, sy, ex, ey
    a1 = startDeg * 3.141592653589793 / 180
    a2 = endDeg * 3.141592653589793 / 180
    sx = cx + arcR * Cos(a1) : sy = cy + arcR * Sin(a1)
    ex = cx + arcR * Cos(a2) : ey = cy + arcR * Sin(a2)
    Dim dirFlag : dirFlag = 1
    If endDeg < startDeg Then dirFlag = -1
    Set seg = Nothing
    Set seg = doc.SketchManager.CreateArc(CDbl(cx), CDbl(cy), CDbl(0), CDbl(sx), CDbl(sy), CDbl(0), CDbl(ex), CDbl(ey), CDbl(0), CInt(dirFlag))
    If seg Is Nothing Then OutFail "SW_SKETCH_FAILED", "arc failed (err " & Err.Number & ": " & Err.Description & ")"
  ElseIf shape = "ellipse" Then
    Dim er1, er2
    er1 = CDbl(NV("Diameter", "0")) / 2000
    er2 = CDbl(NV("Minor", "0")) / 2000
    If er2 <= 0 Then er2 = er1 / 2
    Set seg = Nothing
    Set seg = doc.SketchManager.CreateEllipse(CDbl(cx), CDbl(cy), CDbl(0), CDbl(cx + er1), CDbl(cy), CDbl(0), CDbl(cx), CDbl(cy + er2), CDbl(0))
    If seg Is Nothing Then OutFail "SW_SKETCH_FAILED", "ellipse failed (err " & Err.Number & ": " & Err.Description & ")"
  ElseIf shape = "polyline" Then
    Dim pts : pts = NV("Points", "")
    If Len(pts) = 0 Then OutFail "SW_BAD_PARAMS", "polyline needs points (x1,y1;x2,y2;...)"
    Dim arr : arr = Split(pts, ";")
    If UBound(arr) < 1 Then OutFail "SW_BAD_PARAMS", "polyline needs at least two points"
    Dim k
    For k = 0 To UBound(arr) - 1
      Dim p1v, p2v
      p1v = Split(Trim(arr(k)), ",")
      p2v = Split(Trim(arr(k + 1)), ",")
      If UBound(p1v) < 1 Or UBound(p2v) < 1 Then OutFail "SW_BAD_PARAMS", "bad point in polyline: " & arr(k)
      Set seg = Nothing
      Set seg = doc.SketchManager.CreateLine(CDbl(CDbl(p1v(0)) / 1000), CDbl(CDbl(p1v(1)) / 1000), CDbl(0), CDbl(CDbl(p2v(0)) / 1000), CDbl(CDbl(p2v(1)) / 1000), CDbl(0))
      If seg Is Nothing Then OutFail "SW_SKETCH_FAILED", "polyline segment failed (err " & Err.Number & ")"
    Next
  ElseIf shape = "centerline" Then
    Dim clArr : clArr = Split(NV("Points", ""), ";")
    If UBound(clArr) < 1 Then OutFail "SW_BAD_PARAMS", "centerline needs two points"
    Dim c1, c2
    c1 = Split(Trim(clArr(0)), ",")
    c2 = Split(Trim(clArr(1)), ",")
    If UBound(c1) < 1 Or UBound(c2) < 1 Then OutFail "SW_BAD_PARAMS", "bad point in centerline"
    Set seg = Nothing
    Set seg = doc.SketchManager.CreateCenterLine(CDbl(CDbl(c1(0)) / 1000), CDbl(CDbl(c1(1)) / 1000), CDbl(0), CDbl(CDbl(c2(0)) / 1000), CDbl(CDbl(c2(1)) / 1000), CDbl(0))
    If seg Is Nothing Then OutFail "SW_SKETCH_FAILED", "centerline failed (err " & Err.Number & ")"
  End If
  OutOK """plane"":" & J(plane) & ",""shape"":" & J(shape)
End Sub

Sub DoExtrude()
  Dim app : Set app = GetSwApp()
  Dim doc : Set doc = GetDoc(app)
  Dim active : Set active = Nothing
  Set active = doc.SketchManager.ActiveSketch
  If active Is Nothing Then OutFail "SW_NO_SKETCH", "no active sketch to extrude"
  Dim depth : depth = CDbl(NV("Depth", "0")) / 1000
  Dim dir : dir = LCase(NV("Direction", "forward"))
  Dim t1, flip
  t1 = 0 : flip = False
  If dir = "reverse" Then flip = True
  If dir = "midplane" Then t1 = 6
  ' Draft: positive angle shrinks the far face, negative widens it.
  Dim draftDeg : draftDeg = CDbl(NV("Draft", "0"))
  Dim hasDraft : hasDraft = (Abs(draftDeg) > 0.0001)
  Dim dchk : dchk = hasDraft
  Dim ddir : ddir = (draftDeg < 0)
  Dim dang : dang = CDbl(Abs(draftDeg)) * CDbl(3.141592653589793) / CDbl(180)
  ' Start offset in mm along the sketch normal (0 = start on the sketch plane).
  Dim startMm : startMm = CDbl(NV("Start", "0"))
  Dim startM : startM = startMm / 1000
  ' T0 selects the start condition: 0 = sketch plane, 3 = offset from it.
  Dim t0 : t0 = 0
  If startMm > 0.0001 Then t0 = 3
  ' merge=false keeps this extrusion as a separate tool body (for boolean cut).
  Dim mergeOn : mergeOn = (NV("Merge", "1") <> "0")
  Dim fe : Set fe = Nothing
  Set fe = doc.FeatureManager.FeatureExtrusion2(True, flip, False, t1, 0, depth, CDbl(0), dchk, False, ddir, False, dang, CDbl(0), False, False, False, False, mergeOn, True, True, t0, CDbl(startM), False)
  If fe Is Nothing Then OutFail "SW_EXTRUDE_FAILED", "extrusion failed (err " & Err.Number & ": " & Err.Description & ")"
  OutOK FeatureStatus(doc) & ",""depth"":" & J(NV("Depth", "0")) & ",""direction"":" & J(dir) & ",""draft"":" & J(NV("Draft", "0")) & ",""start"":" & J(NV("Start", "0")) & ",""merge"":" & LCase(CStr(mergeOn))
End Sub

Sub DoCut()
  Dim app : Set app = GetSwApp()
  Dim doc : Set doc = GetDoc(app)
  Dim active : Set active = Nothing
  Set active = doc.SketchManager.ActiveSketch
  If active Is Nothing Then OutFail "SW_NO_SKETCH", "no active sketch to cut with"
  Dim throughAll : throughAll = (NV("Through_all", "0") = "1")
  Dim t1 : t1 = 0
  If throughAll Then t1 = 1
  Dim depth : depth = CDbl(NV("Depth", "0")) / 1000
  Dim flip : flip = (LCase(NV("Direction", "forward")) = "reverse")
  Dim fe : Set fe = Nothing
  Set fe = doc.FeatureManager.FeatureCut4(True, flip, False, t1, 0, depth, CDbl(0), False, False, False, False, CDbl(0), CDbl(0), False, False, False, False, False, False, False, False, False, False, 0, CDbl(0), False, False)
  If fe Is Nothing Then OutFail "SW_CUT_UNSUPPORTED", "extrude-cut is not available on this SolidWorks automation surface (err " & Err.Number & ")"
  OutOK FeatureStatus(doc) & ",""throughAll"":" & LCase(CStr(throughAll))
End Sub

Sub DoFillet()
  Dim app : Set app = GetSwApp()
  Dim doc : Set doc = GetDoc(app)
  Dim cnt : cnt = SelectSolidFeatures(doc)
  Dim r : r = CDbl(NV("Radius", "0")) / 1000
  Dim fe : Set fe = Nothing
  Set fe = doc.FeatureManager.FeatureFillet(171, r, 0, 0, Nothing, Nothing, Nothing)
  If fe Is Nothing Then OutFail "SW_FILLET_FAILED", "fillet failed (err " & Err.Number & ": " & Err.Description & ")"
  OutOK FeatureStatus(doc) & ",""radius"":" & J(NV("Radius", "0")) & ",""edgeCount"":" & cnt
End Sub

Sub DoChamfer()
  Dim app : Set app = GetSwApp()
  Dim doc : Set doc = GetDoc(app)
  Dim cnt : cnt = SelectSolidFeatures(doc)
  Dim d : d = CDbl(NV("Distance", "0")) / 1000
  Dim ang : ang = CDbl(NV("Angle", "45"))
  Dim fe : Set fe = Nothing
  Set fe = doc.FeatureManager.InsertFeatureChamfer(4, 2, d, ang, CDbl(0), CDbl(0), CDbl(0), CDbl(0))
  If fe Is Nothing Then OutFail "SW_CHAMFER_UNSUPPORTED", "chamfer is not available on this SolidWorks automation surface (err " & Err.Number & ")"
  OutOK FeatureStatus(doc) & ",""distance"":" & J(NV("Distance", "0")) & ",""angle"":" & J(NV("Angle", "45"))
End Sub

Sub DoRevolveCut()
  Dim app : Set app = GetSwApp()
  Dim doc : Set doc = GetDoc(app)
  Dim active : Set active = Nothing
  Set active = doc.SketchManager.ActiveSketch
  If active Is Nothing Then OutFail "SW_NO_SKETCH", "no active sketch to revolve-cut (profile + centerline required)"
  Dim angDeg : angDeg = CDbl(NV("Angle", "360"))
  Dim angRad : angRad = angDeg * 3.141592653589793 / 180
  Dim fe : Set fe = Nothing
  Set fe = doc.FeatureManager.FeatureRevolveCut2(CDbl(angRad), False, CDbl(0), 0, 0, False, False, False, False, False)
  If fe Is Nothing Then OutFail "SW_REVOLVE_CUT_FAILED", "revolve cut failed (err " & Err.Number & ": " & Err.Description & ")"
  OutOK FeatureStatus(doc) & ",""angle"":" & J(NV("Angle", "360"))
End Sub

Sub DoNewAssembly()
  Dim app : Set app = GetSwApp()
  ' Do not call GetDefaultTemplate for assemblies on this automation surface:
  ' it can abort the script silently. Scan the template folders instead.
  Dim t : t = ""
  Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")
  If fso.FolderExists("C:\ProgramData\SolidWorks") Then
    Dim base, subF, tdir, f, best, bestNum, num
    Set base = fso.GetFolder("C:\ProgramData\SolidWorks")
    best = "" : bestNum = -1
    For Each subF In base.SubFolders
      tdir = subF.Path & "\templates"
      If fso.FolderExists(tdir) Then
        num = ParseVersion(subF.Name)
        If num > bestNum Then
          For Each f In fso.GetFolder(tdir).Files
            If LCase(fso.GetExtensionName(f.Name)) = "asmdot" Then
              best = f.Path : bestNum = num
              If InStr(1, LCase(f.Name), "assem") > 0 Then t = f.Path : Exit For
            End If
          Next
        End If
        If Len(t) > 0 Then Exit For
      End If
    Next
    If Len(t) = 0 Then t = best
  End If
  If Len(t) = 0 Then OutFail "SW_NO_TEMPLATE", "no assembly template (.asmdot) found"
  Dim doc : Set doc = Nothing
  Set doc = app.NewDocument(t, 0, 0, 0)
  If doc Is Nothing Then OutFail "SW_NEW_DOC_FAILED", "NewDocument (assembly) returned nothing"
  Dim units : units = SetUnits(app)
  Dim title : title = ""
  title = doc.GetTitle
  If Err.Number <> 0 Then Err.Clear : title = ""
  OutOK """title"":" & J(title) & ",""units"":" & J(units) & ",""isAssembly"":true"
End Sub

Sub DoAddComponent()
  Dim app : Set app = GetSwApp()
  Dim doc : Set doc = GetDoc(app)
  Dim p : p = NV("Path", "")
  Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")
  If Len(p) = 0 Or Not fso.FileExists(p) Then OutFail "SW_BAD_PATH", "component path not found: " & p
  Dim x, y, z
  x = CDbl(NV("X", "0")) / 1000
  y = CDbl(NV("Y", "0")) / 1000
  z = CDbl(NV("Z", "0")) / 1000
  Dim comp : Set comp = Nothing
  Set comp = doc.AddComponent5(p, 0, "", False, "", CDbl(x), CDbl(y), CDbl(z))
  If comp Is Nothing Then OutFail "SW_ASSEMBLY_FAILED", "AddComponent5 failed (err " & Err.Number & ": " & Err.Description & ") - is this an assembly document?"
  Dim angDeg : angDeg = CDbl(NV("Angle", "0"))
  If Abs(angDeg) > 0.0001 Then
    Dim mu : Set mu = app.GetMathUtility()
    Dim pnt : Set pnt = Nothing
    Set pnt = mu.CreatePoint(Array(CDbl(x), CDbl(y), CDbl(z)))
    Dim vec : Set vec = Nothing
    Set vec = mu.CreateVector(Array(CDbl(0), CDbl(0), CDbl(1)))
    Dim mt : Set mt = Nothing
    Set mt = mu.CreateTransformRotateAxis(pnt, vec, CDbl(angDeg) * 3.141592653589793 / 180)
    If mt Is Nothing Then OutFail "SW_ASSEMBLY_FAILED", "cannot build rotation transform"
    Set comp.Transform2 = mt
    If Err.Number <> 0 Then OutFail "SW_ASSEMBLY_FAILED", "component rotate failed (err " & Err.Number & ": " & Err.Description & ")"
  End If
  OutOK """path"":" & J(p) & ",""x"":" & J(NV("X", "0")) & ",""y"":" & J(NV("Y", "0")) & ",""z"":" & J(NV("Z", "0")) & ",""angle"":" & J(NV("Angle", "0"))
End Sub

Function CountMates(doc)
  Dim f : Set f = Nothing
  Set f = doc.FirstFeature()
  Dim n : n = 0
  Do While Not f Is Nothing
    If InStr(f.GetTypeName2(), "MateGroup") > 0 Then
      Dim sf : Set sf = Nothing
      Set sf = f.GetFirstSubFeature()
      Do While Not sf Is Nothing
        n = n + 1
        Set sf = sf.GetNextSubFeature()
        If Err.Number <> 0 Then Err.Clear : Set sf = Nothing
      Loop
    End If
    Set f = f.GetNextFeature()
    If Err.Number <> 0 Then Err.Clear : Set f = Nothing
  Loop
  CountMates = n
End Function

Sub DoAddMate()
  Dim app : Set app = GetSwApp()
  Dim doc : Set doc = GetDoc(app)
  Dim tstr : tstr = LCase(NV("Type", "coincident"))
  Dim mt : mt = CLng(0)
  If tstr = "concentric" Then mt = 1
  Dim ax, ay, az, bx, by, bz
  ax = CDbl(NV("X1", "0")) / 1000
  ay = CDbl(NV("Y1", "0")) / 1000
  az = CDbl(NV("Z1", "0")) / 1000
  bx = CDbl(NV("X2", "0")) / 1000
  by = CDbl(NV("Y2", "0")) / 1000
  bz = CDbl(NV("Z2", "0")) / 1000
  Dim n0 : n0 = CountMates(doc)
  doc.ClearSelection2 True
  If Err.Number <> 0 Then Err.Clear
  Dim r1 : r1 = doc.Extension.SelectByID2("", "FACE", CDbl(ax), CDbl(ay), CDbl(az), False, 0, Nothing, 0)
  If r1 <> True Then OutFail "SW_MATE_FAILED", "cannot select the first face at the given point"
  Err.Clear
  Dim r2 : r2 = doc.Extension.SelectByID2("", "FACE", CDbl(bx), CDbl(by), CDbl(bz), True, 0, Nothing, 0)
  If r2 <> True Then OutFail "SW_MATE_FAILED", "cannot select the second face at the given point"
  Err.Clear
  doc.AddMate CLng(mt), CLng(0), False, CDbl(0), CDbl(0)
  If Err.Number <> 0 Then OutFail "SW_MATE_FAILED", "AddMate failed (err " & Err.Number & ": " & Err.Description & ")"
  Dim n1 : n1 = CountMates(doc)
  doc.ClearSelection2 True
  Dim mc : mc = 0
  If Not IsEmpty(n1) Then
    mc = n1
    If n1 <= n0 Then OutFail "SW_MATE_FAILED", "mate was not created"
  End If
  OutOK """mateType"":" & CStr(mt) & ",""mateCount"":" & CStr(mc)
End Sub

' NOTE (VBScript quirk on this host): a runtime error raised inside a Sub
' aborts the remaining statements of that Sub silently - even with a global
' On Error Resume Next. Risky statements therefore live in tiny Functions so
' the caller can inspect the returned flag.
Function TryCloseDoc(app, p)
  On Error Resume Next
  app.CloseDoc p
  If Err.Number <> 0 Then TryCloseDoc = False Else TryCloseDoc = True
  Err.Clear
End Function

Function TryDeleteFile(fso, p)
  On Error Resume Next
  fso.DeleteFile p, True
  If Err.Number <> 0 Then TryDeleteFile = False Else TryDeleteFile = True
  Err.Clear
End Function

Sub DoSave()
  Dim app : Set app = GetSwApp()
  Dim doc : Set doc = GetDoc(app)
  Dim p : p = NV("Path", "")
  If Len(p) = 0 Then OutFail "SW_BAD_PATH", "empty save path"
  Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")
  Dim dirPath : dirPath = fso.GetParentFolderName(p)
  EnsureDir fso, dirPath
  ' A previously saved document may still hold this path (and the lock).
  Dim activePath : activePath = ""
  activePath = doc.GetPathName
  If Err.Number <> 0 Then Err.Clear : activePath = ""
  If LCase(Trim(activePath)) <> LCase(p) Then
    Dim fname : fname = Mid(p, InStrRev(p, "\") + 1)
    Dim dotPos : dotPos = InStrRev(fname, ".")
    If dotPos > 0 Then fname = Left(fname, dotPos - 1)
    Dim closed : closed = TryCloseDoc(app, fname)
    If Not closed Then closed = TryCloseDoc(app, p)
    If closed Then WScript.Sleep 800
  End If
  Dim delOk : delOk = True
  If fso.FileExists(p) Then delOk = TryDeleteFile(fso, p)
  If Not delOk Then OutFail "SW_SAVE_FAILED", "target file is locked by another SolidWorks document; close it in SolidWorks and retry"
  doc.SaveAs3 p, 0, 1
  If Err.Number <> 0 Then OutFail "SW_SAVE_FAILED", "save failed (err " & Err.Number & ": " & Err.Description & ")"
  Dim got : got = ""
  got = doc.GetPathName
  If Err.Number <> 0 Then Err.Clear : got = ""
  If LCase(Trim(got)) <> LCase(p) Then OutFail "SW_SAVE_FAILED", "save did not take effect (path=[" & got & "])"
  Dim size : size = 0
  If fso.FileExists(p) Then size = fso.GetFile(p).Size
  OutOK """path"":" & J(p) & ",""sizeBytes"":" & size
End Sub

Sub DoCheck()
  Dim app : Set app = GetSwApp()
  Dim doc : Set doc = GetDoc(app)
  Dim dtype : dtype = 0
  dtype = doc.GetType()
  If Err.Number <> 0 Then Err.Clear : dtype = 0
  If dtype = 2 Then
    ' Assembly: feature/body walks are not available here; do a light check.
    Dim arb : arb = False
    Dim ar : ar = doc.EditRebuild3
    If Err.Number = 0 Then arb = CBool(ar) Else Err.Clear
    Dim atitle : atitle = ""
    atitle = doc.GetTitle
    If Err.Number <> 0 Then Err.Clear : atitle = ""
    Dim apath : apath = ""
    apath = doc.GetPathName
    If Err.Number <> 0 Then Err.Clear : apath = ""
    Dim aunitsOk : aunitsOk = False
    Dim aread : aread = app.GetUserPreferenceIntegerValue(105)
    If Err.Number = 0 Then
      If aread = 0 Then aunitsOk = True
    Else
      Err.Clear
    End If
    OutOK """rebuildOk"":" & LCase(CStr(arb)) & ",""featureCount"":null,""featureErrors"":[],""clean"":" & LCase(CStr(arb)) & ",""unitsOk"":" & LCase(CStr(aunitsOk)) & ",""bodyCount"":null,""hasMass"":false,""mass"":null,""volume"":null,""surfaceArea"":null,""title"":" & J(atitle) & ",""savedPath"":" & J(apath) & ",""isAssembly"":true"
  End If
  Dim st : st = FeatureStatus(doc)
  Dim unitsOk : unitsOk = False
  Dim unitsRead : unitsRead = app.GetUserPreferenceIntegerValue(105)
  If Err.Number = 0 Then
    If unitsRead = 0 Then unitsOk = True
  Else
    Err.Clear
  End If
  Dim hasMass : hasMass = False
  Dim mass, vol, area
  Dim mp : Set mp = Nothing
  Set mp = doc.Extension.CreateMassProperty
  If Not mp Is Nothing Then
    mp.UseSystemUnits = True
    mass = mp.Mass
    vol = mp.Volume
    area = mp.SurfaceArea
    If Err.Number = 0 Then hasMass = True Else Err.Clear
  Else
    Err.Clear
  End If
  Dim title : title = ""
  title = doc.GetTitle
  If Err.Number <> 0 Then Err.Clear : title = ""
  Dim savedPath : savedPath = ""
  savedPath = doc.GetPathName
  If Err.Number <> 0 Then Err.Clear : savedPath = ""
  Dim massJson, volJson, areaJson
  massJson = "null" : volJson = "null" : areaJson = "null"
  If hasMass Then
    massJson = CStr(mass) : volJson = CStr(vol) : areaJson = CStr(area)
  End If
  Dim bodyCount : bodyCount = 0
  Dim bodies : bodies = doc.GetBodies2(0, False)
  If Err.Number = 0 Then
    If IsArray(bodies) Then
      Dim ub : ub = UBound(bodies)
      If Err.Number = 0 And ub >= 0 Then bodyCount = ub + 1 Else Err.Clear
    End If
  Else
    Err.Clear
  End If
  OutOK st & ",""unitsOk"":" & LCase(CStr(unitsOk)) & ",""bodyCount"":" & bodyCount & ",""hasMass"":" & LCase(CStr(hasMass)) & ",""mass"":" & massJson & ",""volume"":" & volJson & ",""surfaceArea"":" & areaJson & ",""title"":" & J(title) & ",""savedPath"":" & J(savedPath)
End Sub

' ---- dispatch ------------------------------------------------------------

Select Case LCase(A)
  Case "connect" : DoConnect
  Case "new_part" : DoNewPart
  Case "draw_sketch" : DoDrawSketch
  Case "extrude" : DoExtrude
  Case "cut" : DoCut
  Case "fillet" : DoFillet
  Case "chamfer" : DoChamfer
  Case "boolean" : DoRevolveCut
  Case "revolve_cut" : DoRevolveCut
  Case "new_assembly" : DoNewAssembly
  Case "add_component" : DoAddComponent
  Case "add_mate" : DoAddMate
  Case "save" : DoSave
  Case "check" : DoCheck
  Case Else : OutFail "SW_BAD_ACTION", "unknown action: " & A
End Select
