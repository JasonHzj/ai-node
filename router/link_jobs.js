const express = require('express');
const router = express.Router();

// 导入处理函数模块
const linkJobsHandler = require('../router_handler/link_jobs');

// --- 定义路由 ---

// POST /api/link-jobs - 创建一个新的换链接任务
router.post('/link-jobs', linkJobsHandler.createLinkJob);

// GET /api/link-jobs - 获取当前用户的所有换链接任务
router.get('/link-jobs', linkJobsHandler.getLinkJobs);
// 可以在此添加更多路由，例如:
// GET /api/link-jobs/:id - 获取单个任务详情
// PUT /api/link-jobs/:id - 更新某个任务
// DELETE /api/link-jobs/:id - 删除某个任务

module.exports = router;
