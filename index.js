// 启用 bytenode，让 Node.js 能够加载 .jsc 文件
require('bytenode');

// 加载并运行我们编译好的、受保护的主应用程序
require('./dist/app.jsc')