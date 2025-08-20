// 文件: router/ads.js

const express = require('express');
const router = express.Router();
const adsHandler = require('../router_handler/ads.js');

// 定义接收Ads脚本数据的路由
// 脚本应该向 /api/ads/receive-data 发送POST请求
router.post('/ads/receive-data', adsHandler.receiveData);

module.exports = router;