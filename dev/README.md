# 개발용 도구

- `mock-server.mjs`: Google 없이 앱 전체를 시험하는 테스트 서버. `apps-script/Code.gs`를 메모리 속 가짜 시트로 실행합니다.
  ```
  node dev/mock-server.mjs   # http://localhost:8080
  ```
- `e2e.cjs`: Playwright로 주요 흐름(교사 가입·학반 세팅·학생 입장·평가·일별 피드백)을 자동 점검합니다. 테스트 서버를 켠 뒤 실행합니다.
  ```
  node dev/e2e.cjs
  ```
