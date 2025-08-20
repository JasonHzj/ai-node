# Dockerfile

# --- 阶段 1: 构建阶段 ---
# 使用一个包含完整构建工具的Node.js官方镜像
FROM node:18-alpine AS builder

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装所有生产环境的依赖
RUN npm install --production

# 复制您项目的所有源代码
COPY . .


# --- 阶段 2: 运行阶段 ---
# 使用一个更小、更安全的Node.js官方镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 从“构建阶段”的镜像中，只复制必要的文件
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app .

# 暴露您的应用运行的端口
EXPOSE 3006

# 容器启动时运行的命令
CMD [ "node", "app.js" ]
