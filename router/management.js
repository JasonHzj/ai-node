const express = require('express');
const router = express.Router();

// 导入路由处理函数模块
const managementHandler = require('../router_handler/management');

// 定义获取换链接管理页面数据的路由
router.get('/management_data', managementHandler.getLinkManagementData);
router.get('/offer_suggestions', managementHandler.getOfferSuggestions);
// 保存（新增或更新）换链接任务的路由
router.post('/save_job', managementHandler.saveLinkJob);
// 导出路由对象
module.exports = router;