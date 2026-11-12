/* 배포자가 한 번만 채우는 값. 사용자 비밀값은 여기 두지 않는다.
   AZURE_CLIENT_ID: Microsoft Entra에 등록한 "결제 기록장" 앱의 애플리케이션(클라이언트) ID.
   비어 있으면 Azure 연결 버튼이 안내 문구만 보여준다. 등록 방법은 README "Azure 앱 등록" 참고. */
(function (root) {
  'use strict';

  const config = {
    AZURE_CLIENT_ID: '',
    REFRESH_HOUR: 8, // 매일 아침 8시(내 컴퓨터 시간)에 갱신
    STALE_AFTER_MS: 6 * 60 * 60 * 1000, // 화면을 열었을 때 6시간 넘게 지났으면 다시 가져온다
  };

  root.PaymentCloudConfig = config;
  if (typeof module !== 'undefined' && module.exports) module.exports = config;
})(globalThis);
