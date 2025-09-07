const express = require('express');
const router = express.Router();
const platformsHandler = require('../router_handler/platforms');

// 定义保存 Linkbux Token 的路由
router.post('/platforms/linkbux/config', platformsHandler.saveLinkbuxConfig);

// 定义获取当前用户交易数据的路由
router.get('/platforms/transactions', platformsHandler.getTransactions);
router.post('/platforms/linkbux/initial-sync', platformsHandler.triggerInitialSync);

module.exports = router;