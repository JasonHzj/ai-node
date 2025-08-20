// =======================================================================
// 文件 2: router/options.js (需要修改)
// 作用: 增加一条新的路由规则来调用上面的处理函数。
// =======================================================================

const express = require('express');
const router = express.Router();

const optionsHandler = require('../router_handler/options.js');

// 保留已有的路由
router.get('/options/countries', optionsHandler.getCountries);
router.get('/options/languages', optionsHandler.getLanguages);

// --- 新增以下路由 ---
// 定义新的联动路由。:countryId 是一个动态参数，可以是数字ID，也可以是'all'
// 例如: GET /api/options/languages-for-country/2826 (获取英国的语言)
// 或 GET /api/options/languages-for-country/all (获取默认语言英语)
router.get('/options/languages-for-country/:countryId', optionsHandler.getLanguagesForCountry);

module.exports = router;