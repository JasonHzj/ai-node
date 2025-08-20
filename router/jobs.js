// 文件: router/jobs.js (最终修正版)

const express = require('express');
const router = express.Router();
const jobsHandler = require('../router_handler/jobs');

// --- 脚本专用接口 (无需登录令牌，使用API密钥) ---
router.get('/jobs/pending', jobsHandler.getPendingJobs);
router.post('/jobs/update-status', jobsHandler.updateJobStatus);


// --- 前端专用接口 (需要登录令牌) ---
router.get('/jobs', jobsHandler.getJobs);
router.post('/jobs/draft', jobsHandler.saveDraft);
router.post('/jobs/submit', jobsHandler.submitJobs);
// 新增：请求删除一个任务的路由
router.post('/jobs/request-deletion', jobsHandler.requestDeletion);
// 如果您有批量导入功能，也放在这里
// router.post('/jobs/import', jobsHandler.importFromExcel);
// 新增：批量请求删除任务的路由
router.post('/jobs/request-batch-deletion', jobsHandler.requestBatchDeletion);
module.exports = router;