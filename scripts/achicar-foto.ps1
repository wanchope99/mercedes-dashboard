# Achica una imagen a un lado largo dado, re-encodeando en JPEG.
#
# Existe para el experimento de `comparar-extractor.js`: la "foto chica" que se
# quiere medir es la variante de ~1280 px que Telegram YA genera y ofrece en
# `message.photo`. Acá no hay Telegram, así que se la reproduce localmente.
#
# LIMITACIÓN, y hay que decirla: esto NO es el archivo de Telegram, es un
# downscale nuestro del original. El kernel de resampleo y la calidad JPEG
# difieren. Para la pregunta que el experimento contesta —¿a 1280 px el modelo
# sigue leyendo el total?— la diferencia no cambia la respuesta; para un
# recuento de bytes exacto, sí.
#
# Uso: powershell -File achicar-foto.ps1 -Entrada foto.jpg -Salida chica.jpg -LadoLargo 1280

param(
  [Parameter(Mandatory=$true)][string]$Entrada,
  [Parameter(Mandatory=$true)][string]$Salida,
  [int]$LadoLargo = 1280,
  [int]$Calidad = 85
)

Add-Type -AssemblyName System.Drawing

$orig = [System.Drawing.Image]::FromFile((Resolve-Path $Entrada).Path)
try {
  $mayor = [Math]::Max($orig.Width, $orig.Height)
  if ($mayor -le $LadoLargo) {
    # Ya es más chica que el objetivo: se copia tal cual en vez de agrandarla.
    # Las medidas se leen ANTES de soltar la imagen; con $orig ya liberado,
    # $orig.Width devuelve vacío y la línea sale como "copiada x".
    $texto = "copiada $($orig.Width)x$($orig.Height)"
    $orig.Dispose()
    $orig = $null
    Copy-Item -LiteralPath (Resolve-Path $Entrada).Path -Destination $Salida -Force
    Write-Output $texto
    exit 0
  }
  $escala = $LadoLargo / $mayor
  $w = [int][Math]::Round($orig.Width * $escala)
  $h = [int][Math]::Round($orig.Height * $escala)

  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($orig, 0, 0, $w, $h)
  $g.Dispose()

  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Calidad)
  $bmp.Save($Salida, $codec, $params)
  $bmp.Dispose()
  Write-Output "$($orig.Width)x$($orig.Height) -> ${w}x${h}"
} finally {
  if ($orig) { $orig.Dispose() }
}
