// =======================================================================
// 文件: router_handler/user.js (最终重构版)
// 作用: 移除 updateMyProfile 中的单 token 逻辑，并新增多平台账户管理函数。
// =======================================================================

const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const {
    Buffer
} = require('buffer');

/**
 * @function register
 * @description 用户注册
 */
exports.register = async (req, res) => {
    const {
        username,
        password
    } = req.body;

    if (!username || !password) {
        return res.cc('用户名或密码不能为空！');
    }

    let client;
    try {
        client = await db.getClient();
        const checkUserSql = 'SELECT * FROM users WHERE username=?';
        const [existingUsers] = await client.query(checkUserSql, [username]);
        if (existingUsers.length > 0) {
            return res.cc('用户名已被占用，请更换其他用户名！');
        }

        const countUsersSql = 'SELECT COUNT(*) as userCount FROM users';
        const [countResult] = await client.query(countUsersSql);
        const isFirstUser = countResult[0].userCount === 0;

        const hashedPassword = bcrypt.hashSync(password, 10);

        const newUser = {
            username,
            password: hashedPassword,
            role: isFirstUser ? 'admin' : 'user',
            status: isFirstUser ? 'approved' : 'pending'
        };

        const insertSql = 'INSERT INTO users SET ?';
        const [insertResult] = await client.query(insertSql, newUser);

        if (insertResult.affectedRows !== 1) {
            return res.cc('注册用户失败，请稍后再试！');
        }

        const message = isFirstUser ?
            '恭喜！您已成为首位用户并自动获得管理员权限！' :
            '注册成功，请等待管理员审核！';
        res.cc(message, 0);

    } catch (error) {
        res.cc(error);
    } finally {
        if (client) {
            client.release();
            console.log("Register: 数据库连接已释放");
        }
    }
};

/**
 * @function login
 * @description 用户登录
 */
exports.login = async (req, res) => {
    const {
        username,
        password
    } = req.body;

    let client;
    try {
        client = await db.getClient();
        const sql = 'SELECT * FROM users WHERE username=?';
        const [users] = await client.query(sql, [username]);

        if (users.length !== 1) {
            return res.cc('登录失败，用户不存在！');
        }

        const user = users[0];

        if (user.status !== 'approved') {
            const statusMap = {
                pending: '您的账户正在审核中，请耐心等待。',
                rejected: '您的账户已被拒绝，请联系管理员。'
            };
            return res.cc(statusMap[user.status] || '登录失败，账户状态异常！');
        }

        const compareResult = bcrypt.compareSync(password, user.password);
        if (!compareResult) {
            return res.cc('登录失败，密码错误！');
        }

        const userPayload = {
            id: user.id,
            username: user.username,
            nickname: user.nickname,
            role: user.role,
            permissions: user.permissions || {}
        };

        const token = jwt.sign(userPayload, config.jwtSecretKey, {
            expiresIn: '10h'
        });

        res.send({
            status: 0,
            message: '登录成功！',
            token: 'Bearer ' + token
        });

    } catch (error) {
        res.cc(error);
    } finally {
        if (client) {
            client.release();
            console.log("Login: 数据库连接已释放");
        }
    }
};

/**
 * @function getMyProfile
 * @description 获取当前登录用户的个人资料
 */
exports.getMyProfile = async (req, res) => {
    let client;
    try {
        client = await db.getClient();
        // 注意：我们从这里移除了 linkbux_api_token 字段，因为它现在由新表管理
        const sql = 'SELECT id, username, nickname, email, role, status, open_router_api_key, permissions FROM users WHERE id=?';
        const [users] = await client.query(sql, [req.user.id]);

        if (users.length !== 1) {
            return res.cc('获取用户信息失败！');
        }
        res.send({
            status: 0,
            message: '获取用户个人资料成功！',
            data: users[0]
        });
    } catch (error) {
        res.cc(error);
    } finally {
        if (client) {
            client.release();
            console.log("GetProfile: 数据库连接已释放");
        }
    }
};

/**
 * @function updateMyProfile
 * @description 更新当前登录用户的个人资料 (密码和OpenRouter密钥)
 */
exports.updateMyProfile = async (req, res) => {
    const {
        old_password,
        new_password,
        open_router_api_key
    } = req.body;
    const userId = req.user.id;
    let client;

    try {
        client = await db.getClient();
        const updateData = {};

        if (old_password && new_password) {
            const sql = 'SELECT password FROM users WHERE id=?';
            const [users] = await client.query(sql, [userId]);
            const compareResult = bcrypt.compareSync(old_password, users[0].password);
            if (!compareResult) {
                return res.cc('旧密码错误！');
            }
            updateData.password = bcrypt.hashSync(new_password, 10);
        }

        if (open_router_api_key !== undefined) {
            updateData.open_router_api_key = open_router_api_key;
        }

        if (Object.keys(updateData).length === 0) {
            return res.cc('没有提供任何需要更新的信息');
        }

        const updateSql = 'UPDATE users SET ? WHERE id=?';
        const [result] = await client.query(updateSql, [updateData, userId]);
        if (result.affectedRows !== 1) {
            return res.cc('更新个人资料失败！');
        }
        res.cc('更新个人资料成功！', 0);

    } catch (error) {
        res.cc(error);
    } finally {
        if (client) {
            client.release();
            console.log("UpdateProfile: 数据库连接已释放");
        }
    }
};


// --- ▼▼▼ 在此处新增以下两个函数 ▼▼▼ ---

/**
 * @function getPlatformAccounts
 * @description 获取当前用户的所有联盟平台账户
 */
exports.getPlatformAccounts = async (req, res) => {
    let client;
    try {
        client = await db.getClient();
        const sql = 'SELECT id, platform_name, account_name FROM user_platform_accounts WHERE user_id = ? ORDER BY id';
        const [accounts] = await client.query(sql, [req.user.id]);
        res.send({
            status: 0,
            message: '获取平台账户列表成功！',
            data: accounts
        });
    } catch (error) {
        res.cc(error);
    } finally {
        if (client) {
            client.release();
            console.log("GetPlatformAccounts: 数据库连接已释放");
        }
    }
};

/**
 * @function savePlatformAccounts
 * @description 批量保存(覆盖)当前用户的所有联盟平台账户
 */
// 修正后的 savePlatformAccounts 函数
exports.savePlatformAccounts = async (req, res) => {
    const {
        accounts
    } = req.body;
    const userId = req.user.id;
    let client;

    if (!Array.isArray(accounts)) {
        return res.cc('请求数据格式不正确，需要提供一个账户数组。');
    }

    try {
        client = await db.getClient();
        await client.beginTransaction(); // 开始事务

        // 1. 不再删除旧数据，而是遍历前端传来的每个账户
        const upsertPromises = accounts.map(acc => {
            // 确保账户的核心信息都存在，防止前端传空对象
            if (!acc.platform_name || !acc.account_name || !acc.api_token) {
                return Promise.resolve(); // 如果是空行或无效数据，则跳过
            }

            const encryptedToken = Buffer.from(acc.api_token).toString('base64');

            if (acc.id) {
                // 2. 如果账户有 id，说明是已存在的账户，执行 UPDATE
                // !! 重要：WHERE 条件中必须同时检查 id 和 user_id，防止越权修改
                const updateSql = `
                    UPDATE user_platform_accounts 
                    SET platform_name = ?, account_name = ?, api_token = ? 
                    WHERE id = ? AND user_id = ?
                `;
                return client.query(updateSql, [acc.platform_name, acc.account_name, encryptedToken, acc.id, userId]);
            } else {
                // 3. 如果账户没有 id，说明是新账户，执行 INSERT
                const insertSql = `
                    INSERT INTO user_platform_accounts 
                    (user_id, platform_name, account_name, api_token) 
                    VALUES (?, ?, ?, ?)
                `;
                return client.query(insertSql, [userId, acc.platform_name, acc.account_name, encryptedToken]);
            }
        });

        // 等待所有的更新和插入操作完成
        await Promise.all(upsertPromises);

        await client.commit(); // 提交事务

        // 4. (最佳实践) 操作成功后，从数据库重新查询完整的账户列表返回给前端
        //    这样前端就不需要再单独请求一次，也避免了数据不一致的问题
        //    注意：为了安全，不要把 api_token 返回给前端
        const selectSql = 'SELECT id, platform_name, account_name FROM user_platform_accounts WHERE user_id = ? ORDER BY id';
        const [updatedAccounts] = await db.query(selectSql, [userId]);

        // 5. 将成功信息和最新的数据一起返回
        res.cc('平台账户保存成功！', 0, updatedAccounts);

    } catch (error) {
        if (client) await client.rollback(); // 出错则回滚
        res.cc(error);
    } finally {
        if (client) {
            client.release();
            console.log("SavePlatformAccounts: 数据库连接已释放");
        }
    }
};

// --- ▲▲▲ 新增结束 ▲▲▲ ---


/**
 * @function getAllUsers
 * @description (管理员功能) 获取所有用户列表
 */
exports.getAllUsers = async (req, res) => {
    let client;
    try {
        client = await db.getClient();
        const sql = 'SELECT id, username, nickname, email, role, status, created_at, permissions FROM users ORDER BY id DESC';
        const [users] = await client.query(sql);
        res.send({
            status: 0,
            message: '获取用户列表成功！',
            data: users
        });
    } catch (error) {
        res.cc(error);
    } finally {
        if (client) {
            client.release();
            console.log("GetAllUsers: 数据库连接已释放");
        }
    }
};

/**
 * @function updateUserStatusAndRole
 * @description (管理员功能) 更新用户的状态或角色
 */
exports.updateUserStatusAndRole = async (req, res) => {
    const targetUserId = req.params.id;
    const {
        status,
        role
    } = req.body;
    let client;

    if (!status && !role) {
        return res.cc('请提供要更新的状态或角色！');
    }

    try {
        client = await db.getClient();
        const updateData = {};
        if (status) updateData.status = status;
        if (role) updateData.role = role;

        const sql = 'UPDATE users SET ? WHERE id=?';
        const [result] = await client.query(sql, [updateData, targetUserId]);

        if (result.affectedRows !== 1) {
            return res.cc('更新用户信息失败！');
        }

        const io = req.app.get('socketio');
        io.emit('users_updated', {
            updatedUserId: targetUserId
        });

        res.cc('更新用户信息成功！', 0);
    } catch (error) {
        res.cc(error);
    } finally {
        if (client) {
            client.release();
            console.log("UpdateUserStatus: 数据库连接已释放");
        }
    }
};

/**
 * @function updateUserPermissions
 * @description (管理员功能) 更新指定用户的页面权限
 */
exports.updateUserPermissions = async (req, res) => {
    const targetUserId = req.params.id;
    const {
        permissions
    } = req.body;
    let client;

    if (!permissions) {
        return res.cc('请提供权限数据');
    }

    try {
        client = await db.getClient();
        const sql = 'UPDATE users SET permissions = ? WHERE id = ?';
        const [result] = await client.query(sql, [JSON.stringify(permissions), targetUserId]);
        if (result.affectedRows !== 1) {
            return res.cc('更新用户权限失败！');
        }
        res.cc('更新用户权限成功！', 0);
    } catch (error) {
        res.cc(error);
    } finally {
        if (client) {
            client.release();
            console.log("UpdateUserPermissions: 数据库连接已释放");
        }
    }
};

//移除联盟账户
exports.deletePlatformAccount = async (req, res) => {
    const {
        id
    } = req.params; // 从 URL 中获取要删除的账户 ID
    const userId = req.user.id;
    let client;

    try {
        client = await db.getClient();

        // 执行删除操作，必须同时验证 id 和 user_id 防止越权删除
        const deleteSql = 'DELETE FROM user_platform_accounts WHERE id = ? AND user_id = ?';
        const [result] = await client.query(deleteSql, [id, userId]);

        if (result.affectedRows === 0) {
            // 如果 affectedRows 是 0，说明没找到对应的记录（可能ID不对或不属于该用户）
            return res.cc('未找到要删除的账户或权限不足。');
        }

        res.cc('账户删除成功！', 0);

    } catch (error) {
        res.cc(error);
    } finally {
        if (client) {
            client.release();
            console.log("DeletePlatformAccount: 数据库连接已释放");
        }
    }
};