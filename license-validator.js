const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    execSync
} = require('child_process');
const {
    networkInterfaces
} = require('os');

// getCurrentFingerprint 函数保持不变，这里省略以保持简洁
// ... (请使用上一版本中完整的 getCurrentFingerprint 函数)
function getCurrentFingerprint() {
    try {
        const command = process.platform === 'win32' ? 'wmic csproduct get uuid' : 'dmidecode -s system-uuid';
        const uuid = execSync(command, {
            stdio: 'pipe'
        }).toString().trim().split('\n').pop().trim();
        if (uuid && uuid.length > 10 && uuid !== '00000000-0000-0000-0000-000000000000') return uuid;
    } catch (error) {}
    try {
        const nets = networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (!net.internal && net.family === 'IPv4' && net.mac && net.mac !== '00:00:00:00:00:00') {
                    return net.mac;
                }
            }
        }
    } catch (e) {}
    return null;
}


function verifyLicense() {
    // 1. 从环境变量中读取许可证密钥
   const licenseKey = '{"data":"{\\"fingerprint\\":\\"b261c64e-a563-4307-82ba-c6a3662676a0\\",\\"expires\\":\\"2099-12-31\\",\\"customerName\\":\\"Customer A\\",\\"features\\":[\\"feature1\\",\\"feature2\\"]}","signature":"fqzrbuQ4b/5oPMu4YXZBZjKqRE/Fxdah2bKK9RN7GlxNNdW5jNG5upCQNwUWLur7vJm2tMPd334SoWkq0iLJiPukRKG4HO8oDT0FOPkDSUYLWDrc/WBzmFWsI0bJ/fAKy0c5H2iqxYl7Qp/Ch6QY8NIDhEqUKTjTbhZmg/zPT6W84mbu/dNmic2xF5noHbvivmHD5cy7uGWHe43mw1ajkJwN1+4sGSCP8hO2mcrLEMAEr4WRz6cyNfqJZwSZmJwUV9xt7HPoaNqb2JXkkqMkneqMtOLBrxcateZ7qmyz5vwcTixgMACt3t5CEiRz+lDzpIfsnRIH1MWNTED6JFZLhg=="}';

    if (!licenseKey) {
        // 如果环境变量不存在，则静默失败或只给一个通用提示
        console.error('Initialization failed. Code: E001');
        process.exit(1);
    }

    // 2. 加载公钥
    const publicKeyPath = path.join(__dirname, 'public_key.pem');
    if (!fs.existsSync(publicKeyPath)) {
        console.error('Initialization failed. Code: E002');
        process.exit(1);
    }
    const publicKey = fs.readFileSync(publicKeyPath, 'utf8');

    let licenseObject;
    try {
        licenseObject = JSON.parse(licenseKey);
    } catch (e) {
        console.error('Initialization failed. Code: E003');
        process.exit(1);
    }

    const {
        data,
        signature
    } = licenseObject;
    if (!data || !signature) {
        console.error('Initialization failed. Code: E004');
        process.exit(1);
    }

    // 3. 验证签名
    const verifier = crypto.createVerify('sha256');
    verifier.update(data);
    verifier.end();
    const isSignatureValid = verifier.verify(publicKey, signature, 'base64');

    if (!isSignatureValid) {
        console.error('Initialization failed. Code: E005');
        process.exit(1);
    }

    const licenseData = JSON.parse(data);

    // 4. 验证过期日期
    const expirationDate = new Date(licenseData.expires);
    if (expirationDate < new Date()) {
        console.error('Initialization failed. Code: E006');
        process.exit(1);
    }

    // 5. 验证硬件指纹
    const licensedFingerprint = licenseData.fingerprint;
    const currentFingerprint = getCurrentFingerprint();

    if (!currentFingerprint || licensedFingerprint !== currentFingerprint) {
        // 关键：如果指纹不匹配或无法获取，也只给通用提示
        console.error('Initialization failed. Code: E007');
        process.exit(1);
    }

    // 校验通过，可以不输出任何信息，让程序静默启动
    // console.log('License validation successful.');
    return licenseData;
}

module.exports = {
    verifyLicense
};