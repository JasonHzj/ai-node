require('dotenv').config(); // <-- 确保这是文件的第一行或最顶部的几行之一
const express = require('express');
const db = require('./db'); // <--- 新增这一行，导入我们重写后的db模块
//导入跨域中间价
const cors = require('cors');
//导入登入注册路由模块
const userRouter = require('./router/user');
//导入个人中心路由模块
const userInfoRouter = require('./router/user');
// --- 新增 --- 导入我们刚刚为 Ads 创建的路由模块
const adsRouter = require('./router/ads');
//作用: 注册我们新创建的广告任务路由模块。
const jobsRouter = require('./router/jobs');
// 国家和语言
const optionsRouter = require('./router/options');
//AI模版
const aiRouter = require('./router/ai');
//API密钥
const keysRouter = require('./router/keys');
// 获取Ads账户列表
const accountsRouter = require('./router/accounts'); 
// --- 新增 --- 导入联盟平台路由模块
const platformsRouter = require('./router/platforms');
// --- 新增 --- 导入定时任务模块
const platformSyncJob = require('./jobs/syncPlatforms');
// --- 新增 --- 导入看板路由模块
const dashboardRouter = require('./router/dashboard'); // <--- 在这里新增导入
const jwt = require('jsonwebtoken');


//导入错误级别中间件
const joi = require('@hapi/joi')

var bodyParser = require('body-parser');
// app.use(bodyParser.urlencoded({ extended: false }));

// parse application/json


const app = express();
//配置跨域全局中间件
app.use(cors());
app.use(bodyParser.json({
   limit: '50mb'
}));
//配置解析表达数据中间件
app.use(express.urlencoded({
   extended: false
}))

//优化res.send
app.use(function (req, res, next) {

   res.cc = function (err, status = 1) {
      res.send({
         status,
         message: err instanceof Error ? err.message : err
      })
   }
   next()
})
//配置解析令牌中间件npm i express-jwt@5.3.3
//导入配置文件
const config = require('./config');
const expressJWT = require('express-jwt');
//解析Tonken 的中间件
app.use(expressJWT({
   secret: config.jwtSecretKey,
   algorithms: ['HS256'] // 明确指定算法，更安全
}).unless({
   // 定义一个“白名单”，这里的接口不需要Token即可访问
   path: [
      // 用户注册和登录接口
      '/api/register',
      '/api/login',
      // **新增：明确将接收Ads脚本数据的接口加入豁免名单**
      '/api/ads/receive-data', // 实时数据接口
      '/api/ads/receive-historical-data', // **(新增)** 历史数据接口
      '/api/ads/receive-data', // 用于前端获取公共选项的接口 (使用正则表达式匹配所有子路径)
      '/api/jobs/pending', // 脚本获取任务接口
      '/api/jobs/update-status', // 脚本更新状态接口
      /^\/api\/options\//
   ]
}));
// 托管静态资源文件
// 1. 导入 http 和 socket.io 模块
const http = require('http');
const {
   Server
} = require("socket.io");

// 2. 创建一个 http 服务器，并将 express 应用作为处理器
const server = http.createServer(app);
// 3. 将 http 服务器传递给 socket.io，初始化 io 实例
const io = new Server(server, {
   // 配置CORS，允许您的Vue前端地址访问
   cors: {
      origin: process.env.CORS_ORIGIN || "*", // 优先从.env读取，如果没有则允许所有
      methods: ["GET", "POST"]
   }
});

// 4. 将 io 实例附加到 app 对象上，以便在所有路由处理函数中都能访问到它
app.set('socketio', io);
// --- ▼▼▼ 核心修改：配置健壮的CORS中间件 ▼▼▼ ---
const corsOptions = {
  origin: function (origin, callback) {
    // 检查请求来源是否与.env中配置的域名匹配
    if (!origin || (process.env.CORS_ORIGIN && process.env.CORS_ORIGIN.indexOf(origin) !== -1)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  credentials: true // 允许携带cookies
};
app.use(cors(corsOptions));
// --- ▲▲▲ 修改结束 ▲▲▲ ---
// 5. 监听 WebSocket 的 "connection" 事件
io.on('connection', (socket) => {
   console.log('一个前端用户已通过WebSocket连接:', socket.id);
// 新增：监听客户端的 'join_room' 事件
socket.on('join_room', (token) => {
   if (!token) {
      console.log(`[Socket.IO] ==> 客户端 ${socket.id} 尝试加入房间但未提供token。`);
      return;
   }

   try {
      // 从 token 中安全地解析出用户信息
      const userInfo = jwt.verify(token.replace('Bearer ', ''), config.jwtSecretKey);
      if (userInfo && userInfo.id) {
         const userId = userInfo.id.toString();
         // 核心操作：让这个 socket 实例加入以 userId 命名的房间
         socket.join(userId);
         console.log(`[Socket.IO] ==> 客户端 ${socket.id} 已成功加入房间: ${userId}`);
      }
   } catch (error) {
      console.error(`[Socket.IO] ==> 验证token失败 (客户端ID: ${socket.id}):`, error.message);
   }
});
   socket.on('disconnect', () => {
      console.log('用户断开WebSocket连接:', socket.id);
   });
});


app.use('/api', userRouter);
// --- 新增 --- 将 adsRouter 也注册在 /api 路径下，这样它就不需要 Token 认证
app.use('/api', adsRouter);


app.use('/api', jobsRouter); // <-- 添加这一行
app.use('/api', optionsRouter);//国家和语言
app.use('/api', aiRouter); //ai
app.use('/api', keysRouter);//api密钥
app.use('/api', accountsRouter); // 获取Ads账户列表
// --- 新增 ---
app.use('/api', platformsRouter);
app.use('/api', dashboardRouter); // <--- 在这里新增挂载
app.use('/api', jobsRouter);
app.use('/my', userInfoRouter);

//错误中间件
app.use((err, req, res, next) => {
   //数据验证失败
   if (err instanceof joi.ValidationError) return res.cc(err)
   // 捕获身份认证失败的错误
   if (err.name === 'UnauthorizedError') return res.cc(err)
   //未知错误
   res.cc(err)
})





async function startServer() {
   try {
      await db.initializePool();

      const port = process.env.PORT_ORIGIN || 3006;
      server.listen(port, () => {
         console.log(`API server and WebSocket running at http://127.0.0.1:${port}`);
      });

      // --- 新增 --- 启动我们的定时任务
      platformSyncJob.start();

   } catch (error) {
      console.error('服务器启动失败，无法连接到数据库:', error);
      process.exit(1);
   }
}

startServer();
