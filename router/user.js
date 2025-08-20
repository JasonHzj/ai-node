// =======================================================================
// 文件 2: router/user.js (用户路由定义)
// 作用: 定义所有与用户相关的URL路径，并增加管理员权限校验。
// =======================================================================

const express = require('express');
const router = express.Router();
const userHandler = require('../router_handler/user.js');

// 注册新用户
router.post('/register', userHandler.register);

// 登录
router.post('/login', userHandler.login);
// 新增：个人中心相关路由
router.get('/user/profile', userHandler.getMyProfile);
router.put('/user/profile', userHandler.updateMyProfile);
// 获取用户的所有平台账户
router.get('/user/platform-accounts', userHandler.getPlatformAccounts);

// 批量保存用户的所有平台账户
router.post('/user/platform-accounts', userHandler.savePlatformAccounts);
// 新增：管理员相关路由
router.get('/admin/users', userHandler.getAllUsers);
router.put('/admin/users/:id', userHandler.updateUserStatusAndRole);
router.put('/admin/users/:id/permissions', userHandler.updateUserPermissions);

// --- 管理员专属路由 ---

// 定义一个简单的管理员权限校验中间件
const checkAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next(); // 是管理员，放行
    } else {
        // 使用您全局的 res.cc 方法返回错误
        res.cc('无权访问，需要管理员权限！');
    }
};

// 获取所有用户列表 (需要管理员权限)
router.get('/admin/users', checkAdmin, userHandler.getAllUsers);

// 更新指定用户的状态或角色 (需要管理员权限)
router.patch('/admin/users/:id', checkAdmin, userHandler.updateUserStatusAndRole);

module.exports = router;