// 文件: router/ad_accounts.js

const express = require('express');
const router = express.Router();
const adAccountsHandler = require('../router_handler/ad_accounts.js');

// GET /api/ad-accounts/dashboard - 获取看板主数据
router.get('/ad-accounts/dashboard', adAccountsHandler.getAdAccountsDashboard);

// PUT /api/ad-accounts/:id - 表格内编辑后保存，触发指令
router.put('/ad-accounts/:id', adAccountsHandler.updateAdAccount);

// POST /api/ad-accounts/balance - 管理余额（首次设置或充值）
router.post('/ad-accounts/balance', adAccountsHandler.manageBalance);

module.exports = router;