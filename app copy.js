require('dotenv').config();
const express = require('express');
const db = require('./db');
const cors = require('cors');
const http = require('http'); // 引入 http 模块
const {
   Server
} = require("socket.io"); // 引入 Server 类
const jwt = require('jsonwebtoken'); // 引入 jsonwebtoken 用于在 socket 中验证
const joi = require('@hapi/joi');
const bodyParser = require('body-parser');

// 导入所有路由模块
const userRouter = require('./router/user');
const adsRouter = require('./router/ads');
const jobsRouter = require('./router/jobs');
const optionsRouter = require('./router/options');
const aiRouter = require('./router/ai');
const keysRouter = require('./router/keys');
const accountsRouter = require('./router/accounts');
const platformsRouter = require('./router/platforms');
const platformSyncJob = require('./jobs/syncPlatforms');
const config = require('./config'); // 导入配置文件

// --- ▼▼▼ 核心修正 #1: 修正 express-jwt 的导入方式 ▼▼▼ ---
const {
   expressjwt
} = require('express-jwt');
// --- ▲▲▲ 修正结束 ▲▲▲ ---

const app = express();
const server = http.createServer(app); // 使用 http 模块创建服务器

// --- 配置 CORS 中间件 ---
app.use(cors()); // 允许所有来源的简单请求

// --- 配置 Body Parser 中间件 ---
app.use(bodyParser.json({
   limit: '50mb'
}));
app.use(express.urlencoded({
   extended: false
}));

// --- 配置自定义响应中间件 res.cc ---
app.use(function (req, res, next) {
   res.cc = function (err, status = 1) {
      res.send({
         status,
         message: err instanceof Error ? err.message : err
      });
   };
   next();
});

// --- ▼▼▼ 核心修正 #2: 使用修正后的 expressjwt 中间件 ▼▼▼ ---
app.use(expressjwt({
   secret: config.jwtSecretKey,
   algorithms: ['HS256']
}).unless({
   path: [
      '/api/register',
      '/api/login',
      '/api/ads/receive-data',
      '/api/jobs/pending',
      '/api/jobs/update-status',
      /^\/api\/options\//
   ]
}));
// --- ▲▲▲ 修正结束 ▲▲▲ ---

// --- ▼▼▼ 核心修正 #3: 配置带认证的 Socket.IO 服务 ▼▼▼ ---
const io = new Server(server, {
   cors: {
      origin: process.env.CORS_ORIGIN || "*",
      methods: ["GET", "POST"]
   }
});
app.set('socketio', io);

// Socket.IO 认证中间件
io.use((socket, next) => {
   const token = socket.handshake.auth.token;
   if (!token) {
      return next(new Error('Authentication error: Token not provided'));
   }
   const tokenStr = token.replace('Bearer ', '');
   jwt.verify(tokenStr, config.jwtSecretKey, (err, decoded) => {
      if (err) {
         return next(new Error('Authentication error: Invalid token'));
      }
      socket.user = decoded; // 将解码后的用户信息附加到 socket
      next();
   });
});

// Socket.IO 连接处理
io.on('connection', (socket) => {
   if (!socket.user) {
      console.log('一个未经授权的用户尝试连接被拒绝。');
      return socket.disconnect();
   }
   console.log(`用户已通过 WebSocket 连接: ${socket.user.username} (ID: ${socket.user.id})`);

   // 让该用户的 socket 连接加入以其用户ID命名的专属房间
   socket.join(socket.user.id.toString());

   socket.on('disconnect', () => {
      console.log(`用户断开 WebSocket 连接: ${socket.user.username}`);
   });
});
// --- ▲▲▲ 修正结束 ▲▲▲ ---

// --- 注册所有路由 ---
app.use('/api', userRouter);
app.use('/api', adsRouter);
app.use('/api', jobsRouter);
app.use('/api', optionsRouter);
app.use('/api', aiRouter);
app.use('/api', keysRouter);
app.use('/api', accountsRouter);
app.use('/api', platformsRouter);
// 注意：'/my' 路由前缀与 userInfoRouter 内容可能与 '/api' 下的 user 路由重复，请根据需要保留一个
app.use('/my', userRouter);

// --- 错误处理中间件 ---
app.use((err, req, res, next) => {
   if (err instanceof joi.ValidationError) return res.cc(err);
   if (err.name === 'UnauthorizedError') return res.cc('身份认证失败！'); // 提供更友好的中文提示
   res.cc(err);
});

// --- 服务器启动函数 ---
async function startServer() {
   try {
      await db.initializePool();
      const port = process.env.PORT_ORIGIN || 3006;
      server.listen(port, () => {
         console.log(`API server and WebSocket running at http://127.0.0.1:${port}`);
      });
      platformSyncJob.start();
   } catch (error) {
      console.error('服务器启动失败，无法连接到数据库:', error);
      process.exit(1);
   }
}

startServer();