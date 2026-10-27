# 검증 기록

검증일: 2026-10-27. Windows, Node.js 24.15.0, npm 11.12.1.

## 자동 검증

- `npm.cmd test`: 6/6 통과. 입력 검증, 궤도 반지름·주기, Walker 간격·위상, GMST·지구고정 좌표, 지구 차폐·중복 링크, 최단 홉·단절·동일 노드.
- `npm.cmd run build`: TypeScript 검사와 Vite 배포 빌드 통과.
- `npm.cmd run test:browser`: Edge에서 지구본·통신 끝점·경로, 일시정지, 추적·해제, 시간 탐색·초기화, 잘못된 설정, 1,584기 재생성, 궤도선 토글을 검증. 외부 HTTP 요청을 차단한 상태에서 외부 요청 0건, pageerror 0건.
- 캡처를 직접 확인해 한글 라벨과 지구 표면·위성·연결선·패킷 표시를 확인. 카메라 및 위치 갱신을 Cesium preUpdate에서 수행해 일시정지 후 시간 이동·성좌 재생성 시 지구 표면이 사라지던 문제를 수정.

- 배포 빌드 추가 검증: preview에서 외부 요청 차단 및 앱 리소스 오류 없음, 위성 1기 동일 노드 처리, 390×844 모바일 패널 열기·상호 배제, WebGL 미지원 시 오류 안내를 확인했습니다.

## 1,584기 성능

- Edge 156 / HeadlessChrome 156, 1440×1000, 장치 배율 1.
- GPU: NVIDIA GeForce RTX 5060 Laptop GPU, ANGLE / Direct3D11.
- 72궤도 × 22기, 550km, 53도, 재생 10배속. ISL 표시, 전체 궤도선 숨김, 위성 1기 선택.
- 브라우저 requestAnimationFrame 간격을 60초 측정: 중앙값 **59.52 FPS**, 2,643 프레임(구간 평균 약 **44.1 FPS**).
- 초기 구현은 중앙값 19.88 FPS. 매 프레임 경로 탐색·색상 설정·옵션 생성 제거, 배경 ISL 선 10Hz 갱신 후 목표 중앙값 30 FPS 충족.
- GPU·브라우저·화면 크기·지도 로딩 등에 따라 달라집니다. 실제 네트워크 패킷 처리량이나 알고리즘 성능을 측정한 값이 아닙니다.

## 배포 및 한계

배포 빌드 검증은 `npm.cmd run preview`의 http://127.0.0.1:4173 에서 진행합니다. 정적 서버는 JavaScript를 올바른 MIME 유형으로 제공해야 합니다. 이 PC의 Python 기본 http.server는 Windows MIME 매핑 때문에 JS를 text/plain으로 제공하므로 검증 서버로 사용하지 않습니다.

빌드의 Cesium 포함 JS는 약 4.41MB(전송 gzip 약 1.19MB)이며 Vite의 큰 청크 경고가 남습니다. 모든 기능이 같은 3D 화면에서 사용되므로 초기 버전에서 불필요한 청크 분할은 하지 않았습니다.

MCSR, 논문 ISL 핸드오버, 실제 TLE, 패킷 큐·혼잡·손실·신뢰성은 구현·검증 대상에서 제외했습니다. 표시되는 패킷은 관찰용 흐름입니다. 성능 수치는 개발 모드의 단일 PC 측정이며 다른 장비에서 보장하지 않습니다.

## Docker 상시 제공

- WSL Ubuntu Docker Engine 29.4.1, Compose v5.1.3에서 실제 빌드·기동 완료. Node 24 Alpine 빌드 → Nginx stable Alpine 제공.
- `docker compose config --quiet` 통과. 컨테이너 `mcsr-sim-web-1`, 호스트 바인딩 `127.0.0.1:5174`, `unless-stopped` 정책 확인.
- Windows에서 http://localhost:5174 HTTP 200, Nginx 설정 검사 통과.
- Docker 제공 주소에서 Edge로 지구본·통신 경로·로컬 자산 확인, 외부 요청과 런타임 오류 없음.
- Nginx를 정상 종료한 뒤 Docker가 컨테이너를 자동 재시작(RestartCount 1)하고 HTTP 200으로 복구하는 것을 확인.
- 현재 사용자 로그인 예약 작업 `MCSR-Sim-WSL` 등록·시작. 실제 Windows 재부팅·재로그인은 수행하지 않았습니다.

- 사용자 요청에 따라 호스트 포트를 5174로 변경하고 컨테이너를 재생성했습니다. http://localhost:5174 HTTP 200과 Docker 포트 127.0.0.1:5174 → 80을 재확인했습니다.
