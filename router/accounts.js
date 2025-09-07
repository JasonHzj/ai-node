const express = require('express');
const router = express.Router();
const accountsHandler = require('../router_handler/accounts');

// 定义获取Ads账户列表的路由: GET /api/accounts
// 此接口受JWT保护
router.post('/accounts', accountsHandler.getAccounts);

module.exports = router;