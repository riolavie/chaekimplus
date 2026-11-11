window.CONFIG = {
  // Google Apps Script 웹 앱 배포 URL (README.md 참고)
  // 예: 'https://script.google.com/macros/s/AKfycb.../exec'
  // 이 앱에 필요한 서버 코드(Code.gs)의 최소 버전
  SERVER_VERSION: 14,

  API_URL: 'https://script.google.com/macros/s/AKfycbz-TG5noNslSDKl-hFgppnVyGwRhQuOoTp4uwGmgcKKmCbSrzHPImeyBYOZCD_pMHnKnQ/exec',

  // 개인별 평가 척도 (높은 점수부터). 문구를 바꾸면 apps-script/Code.gs 의 SCALE_LABELS 도 같이 바꿔주세요.
  SCALE: [
    { value: 5, label: '매우 잘함' },
    { value: 4, label: '잘함' },
    { value: 3, label: '보통' },
    { value: 2, label: '아쉬움' },
    { value: 1, label: '노력 필요' },
  ],

  // 학반 초기 세팅에서 '예시 역할 불러오기'로 넣는 역할
  SAMPLE_ROLES: [
    { name: '검사 담당', count: 2, inspector: true },
    { name: '교실 바닥 쓸기', count: 4 },
    { name: '복도 청소', count: 2 },
    { name: '칠판 정리', count: 1 },
    { name: '분리수거', count: 2 },
    { name: '창문·환기', count: 1 },
    { name: '우유·급식 당번', count: 2 },
  ],
};
