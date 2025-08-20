// 文件: db/index.js (最终解决方案 - 自动重连)

const {
    Client
} = require('ssh2');
const mysql = require('mysql2/promise');
const net = require('net');
require('dotenv').config();

let pool = null;
let sshClient = null;
let localTcpServer = null;
let isConnecting = false; // 状态锁，防止并发重连
const localPort = 3307;

const sshConfig = {
    host: process.env.SSH_HOST,
    port: process.env.SSH_PORT,
    username: process.env.SSH_USER,
    password: process.env.SSH_PASSWORD,
    readyTimeout: 20000, // 增加SSH连接超时
    keepaliveInterval: 15000 // 缩短心跳间隔
};

const dbConfig = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
};

const initializePool = async () => {
    // 如果正在连接或已连接，则直接返回
    if (isConnecting || pool) return;

    isConnecting = true;
    console.log('正在初始化数据库连接...');

    try {
        const stream = await new Promise((resolve, reject) => {
            sshClient = new Client();

            const handleSshDisconnect = (reason) => {
                console.log(`SSH 客户端已断开 (原因: ${reason})。`);
                if (localTcpServer) localTcpServer.close();
                if (pool) pool.end();
                if (sshClient) sshClient.removeAllListeners();

                localTcpServer = null;
                pool = null;
                sshClient = null;
                isConnecting = false;

                // ▼▼▼ 核心修正：触发自动重连 ▼▼▼
                console.log('将在5秒后尝试自动重连...');
                setTimeout(initializePool, 5000);
            };

            sshClient.on('ready', () => {
                console.log('SSH 客户端已准备就绪');
                localTcpServer = net.createServer((sock) => {
                    if (!sshClient) return sock.destroy();
                    sshClient.forwardOut(
                        sock.remoteAddress, sock.remotePort,
                        dbConfig.host, dbConfig.port,
                        (err, forwardStream) => {
                            if (err) return sock.end();
                            sock.pipe(forwardStream);
                            forwardStream.pipe(sock);
                        }
                    );
                }).listen(localPort, '127.0.0.1', () => {
                    console.log(`本地端口 ${localPort} 正在监听...`);
                    pool = mysql.createPool({
                        ...dbConfig,
                        host: '127.0.0.1',
                        port: localPort,
                        waitForConnections: true,
                        connectionLimit: 15,
                        connectTimeout: 20000
                    });

                    pool.on('error', (poolErr) => console.error('数据库连接池发生错误:', poolErr));

                    console.log('正在执行健康检查...');
                    pool.getConnection()
                        .then(conn => conn.query('SELECT 1').finally(() => conn.release()))
                        .then(() => {
                            console.log('数据库健康检查成功！');
                            isConnecting = false;
                            resolve(); // 初始化成功
                        })
                        .catch(err => {
                            console.error('健康检查失败:', err);
                            handleSshDisconnect('health_check_failed');
                            reject(err);
                        });
                });
            });

            sshClient.on('error', (err) => {
                console.error('SSH 客户端发生错误:', err);
                handleSshDisconnect('error');
            });
            sshClient.on('close', () => handleSshDisconnect('close'));
            sshClient.on('end', () => handleSshDisconnect('end'));

            sshClient.connect(sshConfig);
        });
    } catch (error) {
        console.error('初始化过程发生致命错误:', error);
        isConnecting = false;
    }
};

const getClient = async () => {
    if (!pool) {
        // 如果连接池不存在，但没有正在进行的连接尝试，则手动触发一次
        if (!isConnecting) {
            console.log('检测到连接池不存在，手动触发重连...');
            initializePool();
        }
        throw new Error('数据库连接不可用，连接池已关闭。请稍后重试。');
    }
    return await pool.getConnection();
};

module.exports = {
    initializePool,
    getClient
};
