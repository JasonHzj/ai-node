const express = require('express');
const router = express.Router();
const keysHandler = require('../router_handler/keys');

// 定义生成新API密钥的路由
// 客户端通过 POST /api/keys 来为自己生成一个新密钥
// 这个接口受JWT保护，用户必须登录才能访问
router.post('/keys', keysHandler.generateApiKey);
router.get('/keys', keysHandler.getMyApiKeys);
router.post('/keys', keysHandler.generateApiKey);
router.delete('/keys/:id', keysHandler.deleteApiKey);
module.exports = router;