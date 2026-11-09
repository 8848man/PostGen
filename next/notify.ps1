param([string]$Title, [string]$Body, [string]$Url)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Information
$icon.Visible = $true
$icon.BalloonTipTitle = $Title
$icon.BalloonTipText = $Body
$icon.add_BalloonTipClicked({ Start-Process -FilePath $Url })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000
$timer.add_Tick({ $timer.Stop(); $icon.Visible = $false; $icon.Dispose(); [System.Windows.Forms.Application]::ExitThread() })
$timer.Start()
$icon.ShowBalloonTip(10000)
[System.Windows.Forms.Application]::Run()
