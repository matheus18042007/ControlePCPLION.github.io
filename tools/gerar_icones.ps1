# Gera os icones PNG do PWA (192, 512 e maskable 512) usando System.Drawing.
# Uso:  powershell -ExecutionPolicy Bypass -File tools\gerar_icones.ps1
Add-Type -AssemblyName System.Drawing

$dir = Join-Path (Split-Path -Parent $PSScriptRoot) 'icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function New-Icone {
    param([int]$Size, [string]$Arquivo, [double]$SafeRatio = 1.0)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'

    # fundo
    $fundo = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(15, 20, 25))
    $g.FillRectangle($fundo, 0, 0, $Size, $Size)

    # area segura (maskable = conteudo menor, dentro do circulo de recorte)
    $pad  = [int]($Size * (1 - $SafeRatio) / 2)
    $inner = $Size - 2 * $pad

    # bloco laranja arredondado
    $r  = [int]($inner * 0.20)
    $x0 = $pad + [int]($inner * 0.13)
    $y0 = $pad + [int]($inner * 0.13)
    $w  = [int]($inner * 0.74)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x0, $y0, $r, $r, 180, 90)
    $path.AddArc($x0 + $w - $r, $y0, $r, $r, 270, 90)
    $path.AddArc($x0 + $w - $r, $y0 + $w - $r, $r, $r, 0, 90)
    $path.AddArc($x0, $y0 + $w - $r, $r, $r, 90, 90)
    $path.CloseFigure()
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point($x0, $y0)),
        (New-Object System.Drawing.Point(($x0 + $w), ($y0 + $w))),
        [System.Drawing.Color]::FromArgb(255, 138, 31),
        [System.Drawing.Color]::FromArgb(255, 95, 31))
    $g.FillPath($grad, $path)

    # marcadores de QR Code (3 cantos) desenhados em vazado escuro
    $escuro = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(18, 24, 31))
    $m  = [int]($w * 0.24)
    $mi = [int]($m * 0.38)
    $off = [int]($w * 0.10)
    $cx = @(($x0 + $off), ($x0 + $w - $off - $m), ($x0 + $off))
    $cy = @(($y0 + $off), ($y0 + $off),           ($y0 + $w - $off - $m))
    $laranja = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 138, 31))
    for ($i = 0; $i -lt 3; $i++) {
        $g.FillRectangle($escuro, [int]$cx[$i], [int]$cy[$i], $m, $m)
        $g.FillRectangle($laranja, [int]($cx[$i] + ($m - $mi) / 2), [int]($cy[$i] + ($m - $mi) / 2), $mi, $mi)
    }
    $laranja.Dispose()

    # "PBA"
    $fs   = [float]($w * 0.20)
    $font = New-Object System.Drawing.Font('Segoe UI', $fs, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt  = New-Object System.Drawing.StringFormat
    $fmt.Alignment     = 'Center'
    $fmt.LineAlignment = 'Center'
    $rect = New-Object System.Drawing.RectangleF(
        [float]($x0 + $w * 0.42), [float]($y0 + $w * 0.60), [float]($w * 0.52), [float]($w * 0.30))
    $g.DrawString('PBA', $font, $escuro, $rect, $fmt)

    $g.Dispose()
    $destino = Join-Path $dir $Arquivo
    $bmp.Save($destino, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "gerado: $destino"
}

New-Icone -Size 192 -Arquivo 'icon-192.png'          -SafeRatio 1.0
New-Icone -Size 512 -Arquivo 'icon-512.png'          -SafeRatio 1.0
New-Icone -Size 512 -Arquivo 'icon-maskable-512.png' -SafeRatio 0.78
