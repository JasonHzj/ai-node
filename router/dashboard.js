// =======================================================================
// 文件: router/dashboard.js
// 作用: 定义与Linkbux数据看板相关的API路由。
// =======================================================================

const express = require('express');
const router = express.Router();
const dashboardHandler = require('../router_handler/dashboard.js');

// 定义获取左上板块核心指标的路由
// GET /api/dashboard/top-left-metrics?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get('/dashboard/top-left-metrics', dashboardHandler.getTopLeftPanelData);

// 定义获取左中板块趋势图数据的路由
// GET /api/dashboard/daily-trends-chart?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get('/dashboard/daily-trends-chart', dashboardHandler.getDailyTrendsChartData);

// 定义获取左下板块累计数据的路由 (此接口不受日期影响)
// GET /api/dashboard/cumulative-stats
router.get('/dashboard/cumulative-stats', dashboardHandler.getCumulativeStatsData);
router.get('/dashboard/top-offers/:accountId', dashboardHandler.getTopOffersForAccount);
// 定义获取中间板块数据的路由
router.get('/dashboard/offer-list', dashboardHandler.getDashboardOfferList);
// ▼▼▼ 新增路由：用于广告远程搜索 ▼▼▼
router.get('/dashboard/search-ads', dashboardHandler.searchAds);
// ▼▼▼ 新增右侧面板的路由 ▼▼▼
router.get('/dashboard/right-panel/summary', dashboardHandler.getRightPanelSummary);
router.get('/dashboard/right-panel/ad-detail', dashboardHandler.getRightPanelAdDetail);


module.exports = router;