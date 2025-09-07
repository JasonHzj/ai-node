# --- STAGE 1: The Builder ---
# 阶段1：负责编译代码的“构建车间”
FROM node:18-alpine AS builder

# 设置工作目录
WORKDIR /app

# ▼▼▼ 新增 ▼▼▼
RUN apk add --no-cache dmidecode

# 复制 package.json 和 lock 文件
COPY package*.json ./

# 安装所有依赖 (包括编译时需要的 devDependencies)
RUN npm install

# 复制所有项目文件（源代码、compile.js 等）到构建车间
COPY . .

# 运行编译脚本，生成包含字节码的 `dist` 文件夹
RUN npm run compile

# (可选优化) 从 node_modules 中移除开发依赖，为下一阶段做准备
RUN npm prune --production


# --- 阶段 2: 运行阶段 (Final Production Image) ---
# 使用一个同样版本、更小、更安全的Node.js官方镜像
FROM node:18-alpine

# 定义并固化许可证环境变量
#ARG APP_LICENSE_KEY_ARG
#ENV APP_LICENSE_KEY=${APP_LICENSE_KEY_ARG}

# 设置工作目录
WORKDIR /app
RUN apk add --no-cache dmidecode

# 1. 从“构建阶段”复制 package.json 和生产依赖
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/node_modules ./node_modules

# 2. 从“构建阶段”复制包含所有编译后字节码的 dist 文件夹
COPY --from=builder /app/dist ./dist

# 3. 从“构建阶段”复制我们的“安全启动器”文件
COPY --from=builder /app/index.js ./index.js

# 暴露您的应用运行的端口
EXPOSE 3006

# 【核心改动】容器启动时，运行我们的安全启动器 index.js
CMD [ "node", "index.js" ]