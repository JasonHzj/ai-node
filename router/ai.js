const express = require('express');
const router = express.Router();

const aiHandler = require('../router_handler/ai');

// 定义AI内容生成的路由
// 客户端通过 POST 请求访问 /api/ai/generate 来调用AI
router.post('/ai/generate', aiHandler.generateAdContent);
// --- 新增：这是为单项重写准备的新路由 ---
router.post('/ai/rewrite-item', aiHandler.rewriteAdItem);

module.exports = router;