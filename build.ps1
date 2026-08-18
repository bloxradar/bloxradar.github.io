# BloxRadar 데이터 갱신 스크립트 (PowerShell 5.1)
# 로블록스 공개 API에서 인기 차트를 새로 받아 template.html에 주입하고
# blox-radar.html을 만든다. 쿠폰 코드는 template.html 안 CODES 배열에
# 손으로 관리한다(공식 API가 없어 자동 수집 불가).
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# 429(요청 제한)에 걸리면 점점 길게 쉬며 최대 4번 재시도한다
function Get-Json($uri, $headers) {
  for ($try = 1; $try -le 4; $try++) {
    try {
      if ($headers) { return Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 30 }
      return Invoke-RestMethod -Uri $uri -TimeoutSec 30
    } catch {
      if ($try -eq 4) { throw }
      Write-Host "retry $try after error: $($_.Exception.Message)"
      Start-Sleep -Seconds (15 * $try)
    }
  }
}

$sid = [guid]::NewGuid().ToString()
# sort 줄을 끝까지 페이지네이션해서 모은다 — 메인 5종 외에 Top Earning/
# Top Rated/Most Popular/장르별 Trending 등 20여 줄이 더 나온다.
$base = "https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=$sid&device=computer&country=all"
$sorts = @(); $tok = $null; $pages = 0
do {
  $u = $base; if ($tok) { $u += "&sortsPageToken=" + [uri]::EscapeDataString($tok) }
  $resp = Get-Json $u
  $sorts += $resp.sorts
  $tok = $resp.nextSortsPageToken
  $pages++
  Start-Sleep -Milliseconds 300
} while ($tok -and $pages -lt 12)
Write-Host "sort rows: $($sorts.Count) (pages: $pages)"

function Pick($sortId) {
  @(($sorts | Where-Object { $_.sortId -eq $sortId }).games |
    Where-Object { -not $_.isSponsored })
}
# 다섯 차트의 전체 목록(각 ~90개)을 모두 수집한다. friends/revisited 는
# 탭 없이 All Games 탭과 검색 풀에만 들어간다.
$picks = @{ trending = Pick 'top-trending'; playing = Pick 'top-playing-now'; rising = Pick 'up-and-coming'; friends = Pick 'fun-with-friends'; revisited = Pick 'top-revisited' }

# ---- 워치리스트: 차트에 없어도 추적할 게임 (watchlist.txt 의 universeId) ----
$watch = @()
if (Test-Path "$root\watchlist.txt") {
  $wlIds = @(Get-Content "$root\watchlist.txt" | ForEach-Object { if ($_ -match '^\s*(\d+)') { $Matches[1] } })
  if ($wlIds.Count) {
    $chunk = $wlIds -join ','
    $votes = @{}
    foreach ($v in (Get-Json "https://games.roblox.com/v1/games/votes?universeIds=$chunk").data) { $votes[[string]$v.id] = $v }
    foreach ($g in (Get-Json "https://games.roblox.com/v1/games?universeIds=$chunk").data) {
      $v = $votes[[string]$g.id]
      $watch += [pscustomobject]@{
        universeId = $g.id; rootPlaceId = $g.rootPlaceId; name = $g.name; playerCount = $g.playing
        totalUpVotes = $(if ($v) { $v.upVotes } else { 0 }); totalDownVotes = $(if ($v) { $v.downVotes } else { 0 })
        isSponsored = $false; genreL1 = $g.genre_l1
      }
    }
  }
}
Write-Host "watchlist: $($watch.Count) games"
$picks.watch = $watch

# ---- 딥 카탈로그: 메인 5종 밖의 모든 sort 줄(장르 Trending·Top Earning·
# Top Rated·Most Popular 등)에서 동접 500명 이상 게임을 흡수한다.
# 탭 없이 All Games 탭과 검색 풀에만 들어간다.
$mainSortIds = @('filters_v5', 'top-trending', 'top-playing-now', 'up-and-coming', 'fun-with-friends', 'top-revisited')
$mainIds = @{}
foreach ($k in @('trending', 'playing', 'rising', 'friends', 'revisited', 'watch')) {
  foreach ($g in $picks[$k]) { $mainIds[[string]$g.universeId] = $true }
}
$deepMap = @{}
foreach ($s in $sorts) {
  if ($mainSortIds -contains $s.sortId) { continue }
  if (-not $s.games) { continue }
  foreach ($g in $s.games) {
    if ($g.isSponsored -or $g.playerCount -lt 500) { continue }
    $id = [string]$g.universeId
    if ($mainIds[$id] -or $deepMap[$id]) { continue }
    $deepMap[$id] = $g
  }
}
$picks.deep = @($deepMap.Values)
Write-Host "deep catalog: $($picks.deep.Count) extra games (>=500 CCU)"

$allIds = @($picks.Values | ForEach-Object { $_ } | ForEach-Object { $_.universeId } | Select-Object -Unique)
$details = @{}; $iconUrl = @{}
for ($i = 0; $i -lt $allIds.Count; $i += 50) {
  $chunk = ($allIds[$i..([Math]::Min($i + 49, $allIds.Count - 1))]) -join ','
  $en = @{}
  foreach ($g in (Get-Json "https://games.roblox.com/v1/games?universeIds=$chunk").data) {
    $details[[string]$g.id] = [pscustomobject]@{ creator = $g.creator.name; visits = $g.visits }
    $en[[string]$g.id] = $g.name
  }
  # 한국어 번역 제목(있으면)을 검색 인덱스용으로 함께 담는다
  foreach ($g in (Get-Json "https://games.roblox.com/v1/games?universeIds=$chunk" @{ "Accept-Language" = "ko-KR,ko;q=0.9" }).data) {
    $id = [string]$g.id
    if ($details[$id] -and $g.name -and $g.name -cne $en[$id]) {
      $details[$id] | Add-Member -NotePropertyName kn -NotePropertyValue $g.name
    }
  }
}

# 아이콘: 메인 차트/워치리스트 게임은 150px, 딥 카탈로그는 50px(용량 절약)
function Get-IconUrls($ids, $size) {
  for ($j = 0; $j -lt $ids.Count; $j += 50) {
    $c = ($ids[$j..([Math]::Min($j + 49, $ids.Count - 1))]) -join ','
    foreach ($x in (Get-Json "https://thumbnails.roblox.com/v1/games/icons?universeIds=$c&size=$size&format=WebP").data) {
      $iconUrl[[string]$x.targetId] = $x.imageUrl
    }
  }
}
$deepIds = @($picks.deep | ForEach-Object { [string]$_.universeId })
$deepSet = @{}; foreach ($d in $deepIds) { $deepSet[$d] = $true }
Get-IconUrls @($allIds | Where-Object { -not $deepSet[[string]$_] }) '150x150'
Get-IconUrls $deepIds '50x50'

$icons = @{}
$wc = New-Object System.Net.WebClient
foreach ($k in $iconUrl.Keys) {
  if ($iconUrl[$k]) {
    $icons[$k] = 'data:image/webp;base64,' + [Convert]::ToBase64String($wc.DownloadData($iconUrl[$k]))
  }
}

# ---- Google 검색 트렌드 (best effort — 실패해도 빌드는 계속된다) ----
# 상위 게임 ~25개의 7일 시간별 검색 관심도를 받아 「최근 24h vs 7일 평균」
# 모멘텀을 계산한다. 쿠키 세션 없이는 429가 나므로 반드시 첫 GET으로 쿠키를 받는다.
$buzz = @{}
try {
  $gua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
  $gs = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $null = Invoke-WebRequest -Uri "https://trends.google.com/" -WebSession $gs -UserAgent $gua -TimeoutSec 20 -UseBasicParsing
  Start-Sleep -Seconds 1
  function CleanName($n) {
    $x = $n -replace '\[[^\]]*\]', ' '
    $x = $x -replace '[^ -~]', ' '
    $x = $x -replace '[^A-Za-z0-9 ]', ' '
    ($x -replace '\s+', ' ').Trim().ToLower()
  }
  $targets = @(); $seen = @{}
  foreach ($g in (@($picks.trending | Select-Object -First 15) + @($picks.playing | Select-Object -First 10))) {
    $id = [string]$g.universeId
    if ($seen[$id]) { continue }; $seen[$id] = $true
    $kw = CleanName $g.name
    if (-not $kw) { continue }
    $targets += [pscustomobject]@{ id = $id; kw = "$kw roblox" }
    if ($targets.Count -ge 25) { break }
  }
  for ($i = 0; $i -lt $targets.Count; $i += 5) {
    $batch = @($targets[$i..([Math]::Min($i + 4, $targets.Count - 1))])
    $items = @($batch | ForEach-Object { @{ keyword = $_.kw; geo = ""; time = "now 7-d" } })
    $req = [uri]::EscapeDataString((@{ comparisonItem = $items; category = 0; property = "" } | ConvertTo-Json -Depth 5 -Compress))
    try {
      $r1 = Invoke-WebRequest -Uri "https://trends.google.com/trends/api/explore?hl=en-US&tz=-540&req=$req" -WebSession $gs -UserAgent $gua -TimeoutSec 20 -UseBasicParsing
      $w = ((($r1.Content -replace "^\)\]\}'", "") | ConvertFrom-Json).widgets | Where-Object { $_.id -eq "TIMESERIES" })
      $wreq = [uri]::EscapeDataString(($w.request | ConvertTo-Json -Depth 10 -Compress))
      Start-Sleep -Seconds 1
      $r2 = Invoke-WebRequest -Uri "https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=-540&req=$wreq&token=$($w.token)" -WebSession $gs -UserAgent $gua -TimeoutSec 20 -UseBasicParsing
      $pts = ((($r2.Content -replace "^\)\]\}',", "") | ConvertFrom-Json)).default.timelineData
      if ($pts.Count -gt 48) {
        for ($k = 0; $k -lt $batch.Count; $k++) {
          $vals = @($pts | ForEach-Object { [double]$_.value[$k] })
          $a7 = ($vals | Measure-Object -Average).Average
          $a24 = ($vals[($vals.Count - 24)..($vals.Count - 1)] | Measure-Object -Average).Average
          if ($a7 -gt 0.5) { $buzz[$batch[$k].id] = [pscustomobject]@{ m = [math]::Round($a24 / $a7, 2) } }
        }
      }
    } catch { Write-Host "buzz batch $($i/5+1) failed: $($_.Exception.Message)" }
    Start-Sleep -Seconds 2
  }
} catch { Write-Host "buzz skipped: $($_.Exception.Message)" }
Write-Host "buzz measured: $($buzz.Count) games"

function Slim($games) {
  @($games | ForEach-Object {
    [pscustomobject]@{ u = $_.universeId; place = $_.rootPlaceId; name = $_.name; playing = $_.playerCount; up = $_.totalUpVotes; down = $_.totalDownVotes; genre = $_.genreL1 }
  })
}
$data = [pscustomobject]@{
  fetchedAt = (Get-Date).ToUniversalTime().ToString('o')
  sorts = [pscustomobject]@{ trending = Slim $picks.trending; playing = Slim $picks.playing; rising = Slim $picks.rising; friends = Slim $picks.friends; revisited = Slim $picks.revisited; watch = Slim $picks.watch; deep = Slim $picks.deep }
  details = $details
  icons = $icons
  buzz = $buzz
}
$json = ($data | ConvertTo-Json -Depth 6 -Compress).Replace('</', '<\/')
$tpl = [IO.File]::ReadAllText("$root\template.html")
[IO.File]::WriteAllText("$root\blox-radar.html", $tpl.Replace('/*__DATA__*/', $json), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "OK: $root\blox-radar.html ($([IO.File]::ReadAllBytes("$root\blox-radar.html").Length) bytes)"
