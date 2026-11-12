import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';

// HTTPS 서버용 키·인증서. 경로가 지정되면 그 파일을 쓰고, 없으면 자체 서명 인증서를 만들어
// DATA_DIR/tls 에 보관한다(재시작해도 같은 인증서라 휴대폰에서 경고를 다시 넘기지 않아도 된다).
export async function loadTlsOptions({ keyPath, certPath, generatedDir }) {
  if (keyPath && certPath) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  const generatedKey = path.join(generatedDir, 'selfsigned-key.pem');
  const generatedCert = path.join(generatedDir, 'selfsigned-cert.pem');
  if (fs.existsSync(generatedKey) && fs.existsSync(generatedCert)) {
    return { key: fs.readFileSync(generatedKey), cert: fs.readFileSync(generatedCert) };
  }

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'chzzk-local' }], {
    days: 365,
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          ...lanAddresses().map((ip) => ({ type: 7, ip })),
        ],
      },
    ],
  });
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(generatedKey, pems.private);
  fs.writeFileSync(generatedCert, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

// 같은 Wi-Fi의 휴대폰이 접속할 수 있는 이 PC의 IPv4 주소들
export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => net.address);
}
