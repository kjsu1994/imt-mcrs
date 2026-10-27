# MCSR · Orbital Network Lab

LEO 성좌와 위성 간 통신 흐름을 관찰하는 프런트엔드 3D 시뮬레이터입니다. React + TypeScript + Vite + CesiumJS. 서버·DB·계정·지도 토큰 없이 동작합니다.

## 실행

Node.js 24와 npm을 사용합니다. PowerShell 실행 정책 문제를 피하려면 `npm.cmd`를 사용하세요.

```powershell
npm.cmd ci
npm.cmd run dev
```

개발 서버: http://127.0.0.1:5173 . 설치에는 인터넷이 필요하지만 설치와 빌드 후 앱 실행에는 필요하지 않습니다.

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run preview
npm.cmd run test:browser
```

브라우저 테스트는 설치된 Microsoft Edge를 사용합니다. `dist/`를 정적 HTTP 서버로 제공하면 배포할 수 있습니다. `file://`로 직접 여는 방식은 지원하지 않습니다. Cesium 정적 파일은 dev/build 전에 로컬로 복사합니다. 클라우드 드라이브에서는 npm 설치·복사가 느릴 수 있습니다.

## 조작

- 지구본 드래그로 극점 제한 없이 상하좌우 연속 회전, 휠·오른쪽 드래그로 확대/축소합니다. 일반 보기의 이동·기울이기는 제한하고, 위성 추적 해제 시에도 지구 중심을 유지합니다. 확대 범위는 지표 기준 약 250~50,000km입니다. 지표까지 거리가 가까울수록 드래그 회전 폭도 줄어듭니다.
- 위성 클릭 또는 위성 선택 목록으로 정보 확인. 위성 추적 / 전체 보기로 카메라 전환.
- 출발·도착 위성을 고르면 초록색 경로와 노란색 패킷 흐름을 표시합니다. 동일 노드는 전송하지 않고, 연결되지 않으면 경로 없음으로 표시합니다.
- 선택 위성을 통신 출발·도착 노드로 지정할 수 있습니다.
- 기본 6×12 및 72×22 Starlink S1 규모 프리셋. 설정 수정 후 성좌 적용.
- 재생·일시정지·초기화·배속·실험 구간 탐색(기본 24시간). 초기화는 앱 실행 시각으로 돌아갑니다.
- 성좌 적용은 시간·위성 선택·추적·통신 끝점·카메라를 초기화합니다. 잘못된 입력은 기존 성좌를 유지합니다.

## 모델과 한계

원형 2체 궤도. 기준 반지름 6,378,137m, 지구 중력상수 3.986004418e14 m³/s². 평균 운동으로 공전하고 GMST로 ECI → ECEF 변환합니다. 단위는 미터·초, 시각은 UTC. J2·대기 항력·실제 TLE·정밀 지구 자세는 미포함입니다. 설정 고도는 구형 기준이며 패널은 WGS84 타원체 고도이므로 약간 다릅니다.

통신은 **시연용 논리 메시 + 지구 차폐 검사 + BFS 최단 홉**입니다. 같은 궤도 앞뒤 위성 및 인접 궤도의 동일 슬롯을 연결하며 첫·끝 궤도 seam은 연결하지 않습니다. 지표 위 1km 여유를 둔 구형 차폐를 적용합니다. 논문의 동방향 최근접 ISL·핸드오버 규칙, MCSR/SRD/DS, 패킷 큐·혼잡·대역폭·손실은 아직 적용하지 않았습니다.

링크 가용 상태는 시뮬레이션 시간 1초 간격으로 평가합니다. 패킷 점은 시뮬레이션 16초에 경로를 통과하는 관찰용 표시이며 실제 통신 시간·처리량과 무관합니다. 경로 변경 시 점은 새 경로로 전환합니다. 위성은 점으로, 궤도선은 궤도당 하나로 표시합니다. 전체 궤도선은 기본 숨김입니다.

## 실험 엔진

`SimulationEngine`은 정수 마이크로초 논리 시계와 사건 큐로 동작합니다. 사건은 시각 → 우선순위 → 등록 순서로 처리하며, 장애 명령 → 기하 갱신 → SLS → 계산 완료 → 경로 설치 순서입니다. 브라우저에서는 전용 Web Worker가 실행하고 Cesium은 약 10Hz 상태 스냅샷 사이의 표시 시각을 매 프레임 보간합니다. 표시는 일반 재생에서 약 100ms 늦을 수 있으며 수신한 논리 시각을 넘기지 않습니다. 위성·ISL·패킷은 같은 표시 시각을 사용합니다. 배속·GPU·FPS는 표시 속도에만 영향을 주며 처리할 사건을 건너뛰지 않습니다.

물리 링크와 라우터가 인지한 링크를 분리합니다. 기하 가용성은 절대 논리 시각 1초 간격으로 갱신하고, 예약 장애는 지정 마이크로초에 반영합니다. SLS는 실험 시작을 기준으로 일정한 간격이며 3회 연속 누락 시 장애를 인지합니다. 복구된 링크는 다음 SLS에서 인지합니다. 정상 링크의 성공 메시지 반복은 생략하고 변경 링크의 관측만 사건으로 실행합니다. 경로는 인지한 그래프에서 계산하며, 이전 그래프 버전의 완료 작업은 폐기합니다.

기본값은 **SLS 100ms, 계산 지연 1ms, 설치 지연 1ms**입니다. 이는 논문에서 검증한 수치가 아닌 실험용 가정입니다. 실제 BFS 실행 시간은 별도 `profiling.wallMs`에만 기록하며 논리 지연과 합산하지 않습니다. 시드는 시나리오에 보존하며 현재 무작위 장애 생성은 없습니다.

- 왼쪽 실험 패널: 길이·SLS·계산/설치 지연 설정, 다음 사건, 끝까지 실행, JSON 저장.
- 오른쪽 ISL 장애 패널: 링크 선택(목록 또는 화면 클릭), 즉시 장애/복구, 시각 예약, 복구 기록.
- 장애부터 인지까지 `detectionUs`, 인지부터 서비스 복구까지 `establishmentUs`, 장애부터 서비스 복구까지 `recoveryUs`입니다. 실제 물리적으로 사용 가능한 경로가 있어야 서비스 복구로 기록합니다.
- 설치 경로에 영향을 주지 않은 장애는 `unaffected`, 종료까지 복구되지 않은 장애는 `unrecovered`이며 시간을 0으로 채우지 않습니다. 평균은 복구된 영향 장애만 포함하므로 미복구 건수와 함께 해석해야 합니다.
- 뒤로 탐색하면 원본 시나리오와 장애 일정을 처음부터 재실행합니다. 성좌·통신 끝점·실험 설정 변경은 새 실험으로 시작하며 장애 일정을 초기화합니다.

저장한 **시나리오 JSON**은 같은 코어로 화면 없이 재생할 수 있습니다. 결과 저장 JSON에는 시나리오·논리 결과·사건 로그·실행 시간 프로파일이 포함됩니다.

```powershell
npm.cmd run simulate -- .\mcsr-scenario.json
```

패킷 점은 시각화만 수행합니다. 패킷별 전달 지연·손실률·큐·전파/직렬화 지연은 아직 측정하지 않습니다. MCSR 적용 전의 BFS 기준선과 복구 실험 기반입니다.

## 코드

- `src/model.ts`: 검증, Walker 원형 궤도·좌표·링크·경로 계산. UI와 독립.
- `src/engine.ts`, `routing.ts`, `metrics.ts`: 논리 시계·사건·링크 상태, BFS, 복구 지표.
- `src/simulation.worker.ts`, `useSimulation.ts`: 실행/재생 제어와 UI 메시지 연결.
- `src/Globe.tsx`: Cesium 생명주기·스냅샷 표시·점·선·패킷·선택·카메라. 매 프레임 좌표를 React state에 넣지 않습니다.
- `src/App.tsx`: 설정·패널·통신 끝점·시간 제어.

## 자산 출처

사용자가 제공한 `logo.png`는 좌측 상단과 favicon, `imt_logo.png`는 헤더 중앙에 사용합니다. 배포 사본은 `public/textures/`에 있습니다.

`public/textures/earth.jpg`: Tom Patterson, Natural Earth III, Earth without clouds. 공개 배포 사본: https://github.com/turban/webgl-earth/blob/master/images/2_no_clouds_4k.jpg . 원 저작자: https://www.shadedrelief.com/natural3/ . Public domain 이용 조건: https://www.shadedrelief.com/natural3/pages/use.html . 출처와 라이선스는 이 문서에 보존하며, 로컬 공개 자산만 사용하므로 화면 크레딧은 숨깁니다.

Cesium 로컬 리소스와 포함 라이선스는 설치 패키지에서 복사합니다. 온라인 지도·ion·지형·지오코더를 사용하지 않습니다. 검증 결과는 `VALIDATION.md`에 기록합니다.

## Docker로 상시 실행

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\docker-up.ps1
```

주소: **http://localhost:5174**. 터미널을 닫아도 실행됩니다. 로컬호스트에만 포트를 바인딩합니다. Node 24 컨테이너에서 소스를 빌드한 뒤 Nginx 컨테이너가 정적 파일을 제공합니다. 코드 수정 후 같은 명령을 다시 실행하면 새 버전으로 교체합니다. 첫 빌드에는 이미지·npm 다운로드를 위한 인터넷이 필요합니다.

일반 Docker CLI가 설치된 환경에서는 `docker compose up -d --build`로도 실행할 수 있습니다. 이 PC는 Docker가 WSL Ubuntu에 있고 O: 클라우드 드라이브는 WSL에서 직접 보이지 않으므로, 위 PowerShell 스크립트가 필요한 파일만 C: 임시 폴더에 복사해 빌드합니다. 컨테이너 실행에는 해당 폴더나 O: 드라이브 마운트가 필요하지 않습니다.

컨테이너는 `restart: unless-stopped`로 Docker 엔진 재시작 후 복구됩니다. 수동으로 중지한 경우는 다시 시작하지 않습니다. WSL 환경 상태와 중지는 다음 명령을 사용하세요.

```powershell
wsl -d Ubuntu --cd / --exec docker ps --filter label=com.docker.compose.project=mcsr-sim
wsl -d Ubuntu --cd / --exec docker stop mcsr-sim-web-1
wsl -d Ubuntu --cd / --exec docker start mcsr-sim-web-1
```

### 이 PC의 로그인 자동 실행

현재 사용자 예약 작업 `MCSR-Sim-WSL`을 등록했습니다. 로그인 시 숨김 PowerShell로 WSL Ubuntu를 시작하고 유지합니다. Ubuntu의 Docker 서비스는 기존에 systemd 자동 시작으로 설정되어 있으며, MCSR 컨테이너는 재시작 정책으로 복구됩니다. O: 드라이브가 아직 마운트되지 않아도 기존 이미지 실행은 가능합니다. Windows 로그인 전의 서비스 가용성은 보장하지 않습니다.

```powershell
Get-ScheduledTask -TaskName MCSR-Sim-WSL
```

자동 실행을 끄려면 다음 명령을 사용하세요. 컨테이너 자체 중지는 별도로 `docker stop`을 사용합니다. 다른 WSL 작업에 영향을 주는 `wsl --shutdown`은 사용하지 마세요.

```powershell
Disable-ScheduledTask -TaskName MCSR-Sim-WSL
Stop-ScheduledTask -TaskName MCSR-Sim-WSL
```

직접 컨테이너를 중지하면 `unless-stopped` 정책상 다음 Docker 시작에도 자동 복구되지 않으므로, 다시 제공하려면 `docker start` 또는 `docker-up.ps1`을 실행하세요.
