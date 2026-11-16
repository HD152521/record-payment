/* 배포자가 한 번만 채우는 값. 사용자 비밀값은 여기 두지 않는다.
   AZURE_CLIENT_ID: Microsoft Entra에 등록한 "결제 기록장" 앱의 애플리케이션(클라이언트) ID.
   비어 있으면 Azure는 연결 화면과 빠른 추가 목록에서 보이지 않는다. 등록 방법은 README "Azure 앱 등록" 참고.
   GITHUB_CLIENT_ID: GitHub App(사용자 권한 Plan: read, device flow 켬)의 Client ID. 비밀키(client secret)는 넣지 않는다.
   비어 있으면 "GitHub 로그인으로 연결" 버튼 대신 안내만 보이고, 토큰 붙여넣기는 그대로 된다.
   AWS_TEMPLATE_URL: 템플릿을 올린 S3 주소. 채우면 AWS 연결 버튼이 CloudFormation 빠른 생성 링크로 열린다. */
(function (root) {
  'use strict';

  const config = {
    AZURE_CLIENT_ID: '',
    GITHUB_CLIENT_ID: '',
    // aws/readonly-cost-user.json 을 올린 공개 S3 주소(https://s3.<리전>.amazonaws.com/<버킷>/<파일> 등).
    // 비어 있으면 "템플릿 파일로 직접 만들기" 안내가 보인다. 업로드는 버킷 운영자가 정한 뒤에 한다.
    AWS_TEMPLATE_URL: '',
    REFRESH_HOUR: 8, // 매일 아침 8시(내 컴퓨터 시간)에 갱신
    STALE_AFTER_MS: 6 * 60 * 60 * 1000, // 화면을 열었을 때 6시간 넘게 지났으면 다시 가져온다
  };

  root.PaymentCloudConfig = config;
  if (typeof module !== 'undefined' && module.exports) module.exports = config;
})(globalThis);
