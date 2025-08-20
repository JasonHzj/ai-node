// =======================================================================
// 文件: router_handler/options.js (最终修复版)
// 核心改动: 1. 使用正确的 client.query 语法
//           2. 确保每个函数都有完整的 try/catch/finally 结构
// =======================================================================

const db = require('../db');

exports.getCountries = async (req, res) => {
    console.log('--- 收到获取国家列表的请求 ---');
    let client;
    try {
        client = await db.getClient();
        const sql = 'SELECT * FROM google_ads_countries ORDER BY name ASC';
        const [countries] = await client.query(sql); // 修正语法

        res.send({
            status: 0,
            message: '获取国家列表成功！',
            data: countries
        });
    } catch (error) {
        console.error('获取国家列表时发生错误:', error);
        res.cc(error);
    } finally {
        if (client) {
            client.release();
            console.log("GetCountries: 数据库连接已释放");
        }
    }
};

exports.getLanguages = async (req, res) => {
    console.log('--- 收到获取所有语言列表的请求 ---');
    let client;
    try {
        client = await db.getClient();
        const sql = 'SELECT * FROM google_ads_languages ORDER BY name ASC';
        const [languages] = await client.query(sql); // 修正语法

        res.send({
            status: 0,
            message: '获取语言列表成功！',
            data: languages
        });
    } catch (error) {
        console.error('获取语言列表时发生错误:', error);
        res.cc(error);
    } finally {
        if (client) {
            client.release();
            console.log("GetLanguages: 数据库连接已释放");
        }
    }
};

exports.getLanguagesForCountry = async (req, res) => {
    const countryId = req.params.countryId;
    console.log(`--- 收到为国家ID [${countryId}] 获取语言列表的请求 ---`);
    let client;
    try {
        client = await db.getClient();

        if (countryId === 'all') {
            const defaultLanguageSql = 'SELECT * FROM google_ads_languages WHERE criterion_id = 1000';
            const [defaultLanguage] = await client.query(defaultLanguageSql); // 修正语法

            return res.send({
                status: 0,
                message: '默认语言（英语）获取成功！',
                data: defaultLanguage
            });
        }

        const countrySql = 'SELECT supported_language_codes FROM google_ads_countries WHERE criterion_id = ?';
        const [countries] = await client.query(countrySql, [countryId]); // 修正语法

        if (countries.length === 0 || !countries[0].supported_language_codes) {
            return res.send({
                status: 0,
                message: '未找到该国家或该国家没有指定的语言',
                data: []
            });
        }

        const languageCodes = countries[0].supported_language_codes.split(',').map(code => code.trim());
        const languagesSql = 'SELECT * FROM google_ads_languages WHERE language_code IN (?) ORDER BY name ASC';
        const [languages] = await client.query(languagesSql, [languageCodes]); // 修正语法

        res.send({
            status: 0,
            message: '获取国家对应语言列表成功！',
            data: languages
        });
    } catch (error) {
        console.error('获取国家对应语言时发生错误:', error);
        res.cc(error);
    } finally {
        if (client) {
            client.release();
        }
    }
};
