//定义验证规则 npm install @hapi/joi@17.1.0
const { string } = require('@hapi/joi')
const joi = require('@hapi/joi')

/**
 * string() 值必须是字符串
 * alphanum() 值只能是包含 a-zA-Z0-9 的字符串
 * min(length) 最小长度
 * max(length) 最大长度
 * required() 值是必填项，不能为 undefined
 * pattern(正则表达式) 值必须符合正则表达式的规则
 */
// --- ▼▼▼ 新增 linkbux_api_token 的验证规则 ▼▼▼ ---
const linkbux_api_token = joi.string().alphanum().allow('').optional()
const username = joi.string().alphanum().min(1).max(10).required()
const password = joi.string().pattern(/^[\S]{6,12}$/).required()
const id = joi.number().integer().min(1).required()
const nickname = joi.string().required()
const email = joi.string().email().required()
const oldPwd = joi.string().pattern(/^[\S]{6,12}$/).required()
const newPwd = joi.string().pattern(/^[\S]{6,12}$/).required()
const avatar = joi.required()
const cover_img = joi.string().required()
const name = joi.string().required()
const alias = joi.string().alphanum().required()
const title = joi.string().required()
const cate_id = joi.number().integer().min(1).required()
const content = joi.string().required().allow('')
const state = joi.string().valid('已发布', '草稿').required()
//页面模块数据
const date = joi.string().required()
const moduleEditTitle = joi.string().required()
const moduleNameId = joi.string().required()
const clickCnt = joi.number().required()
const clickUv = joi.number().required()
const clickRate = joi.number().required()
const leOrderByrCnt = joi.number().required()
const leOrderAmt = joi.number().required()
const leOrderRate = joi.number().required()
const lePayBuyerCnt = joi.number().required()
const lePayAmt = joi.number().required()
const lePayRate = joi.number().required()
//按日期查询
const starDate = joi.required()
const endDate = joi.required()
//check
const renqunList = joi.required()
const checkArr = joi.required()
const fieldName = joi.required()
const type = joi.required()
const titleName = joi.string().required()
const uclickName = joi.required()
const timeStar = joi.required()
const timeEnd = joi.required()
//lp
const lpsumData = joi.required()
const yhqSaqData = joi.required()
//hp
const hpsumData = joi.required()
const qdsumData = joi.required()
const hpsum = joi.required()

const start = joi.required()
const end = joi.required()
const className = joi.required()

const rcA = joi.required()
const rcB = joi.required()

const rcC = joi.required()
const rcD = joi.required()
const clickName = joi.required()
const outus = joi.required()
const listName = joi.required()
const firstName = joi.required()
const qdrqsumData = joi.required()

exports.reg_login_schema = {
  body: {
    username,
    password
  }
}

exports.update_userinfo_schema = {
  body: {
    nickname,
    email
  }
}

exports.upadate_password_schema = {
  body: {
    oldPwd: password,
    newPwd: joi.not(joi.ref('oldPwd')).concat(password)
  }
}

exports.update_avatar_schema = {
  body: {
    avatar
  }
}

exports.add_cate_schema = {
  body: {
    name,
    alias
  }
}

exports.get_cate_schema = {
  params: {
    id,
  },
}

exports.update_cate_schema = {
  body: {
    id: id,
    name,
    alias,
  },
}


exports.article_add_schema = {
  body: {
    title,
    cate_id,
    content,
    state
  },
}

exports.ymmoudle_add_schema = {
  body: {
    name,
    date,
    moduleEditTitle,
    moduleNameId,
    clickCnt,
    clickUv,
    clickRate,
    leOrderByrCnt,
    leOrderAmt,
    leOrderRate,
    lePayBuyerCnt,
    lePayAmt,
    lePayRate
  },
}

exports.strDate_add_schema = {
  body: {
    starDate,
    endDate
  },
}

exports.checkArr_add_schema = {
  body: {
    checkArr,
    fieldName,
    type,
    titleName,
    uclickName,
    timeStar,
    timeEnd,
    renqunList
  },
}
exports.checkArrasd_add_schema = {
  body: {
    checkArr,
    fieldName,
    type,
    titleName,
    uclickName,
    timeStar,
    timeEnd
  },
}


exports.lpdata_add_schema = {
  body: {
   lpsumData
  },
}

exports.yhqdata_add_schema = {
  body: {
    yhqSaqData
  },
}

exports.ppxxdata_add_schema = {
  body: {
    lpsumData
  },
}

exports.hpdata_add_schema = {
  body: {
    hpsumData
  },
}

exports.qddata_add_schema = {
  body: {
    qdsumData
  },
}

exports.qdrqdata_add_schema = {
  body: {
    qdrqsumData
  },
}

exports.hpsum_add_schema = {
  body: {
    checkArr,
    fieldName,
    type,
    titleName,
     uclickName,
     timeStar,
     timeEnd
  },
}

exports.hpname_add_schema = {
  body: {
    timeStar,
    timeEnd
  },
}
exports.rqname_add_schema = {
  body: {
    timeStar,
    timeEnd,
    renqunList
  },
}

exports.hd_add_schema = {
  body: {
    title,
    start,
    end,
    className
  },
}


exports.hd_up_schema = {
  body: {
    title,
    start,
    end,
    className,
    id
  },
}


exports.hd_del_schema = {
  body: {
    id
  },
}


exports.hd_rc_schema = {
  body: {
    rcA,
    rcB,
    rcC,
    rcD,
  },
}

exports.hd_hds_schema = {
  body: {
    outus,
    rcA,
    rcB,
    rcC,
    rcD,
  },
}

exports.click_add_schema = {
  body: {
    clickName
  },
}
exports.hd_hdus_schema = {
  body: {
    rcA,
    rcB,
    rcC,
    rcD,
    clickName
  },
}

exports.hz_date_schema = {
  body: {
    listName,
    firstName,
    type,
    titleName,
    uclickName,
    checkArr,
    timeStar,
    timeEnd
  },
}

exports.hz_dateName_schema = {
  body: {
    listName,
    timeStar,
    timeEnd
  }
}

exports.update_user_info_schema = {
    body: {
      nickname,
      email,
      // --- ▼▼▼ 新增 ▼▼▼ ---
      linkbux_api_token
      // --- ▲▲▲ 新增结束 ▲▲▲ ---
    }

