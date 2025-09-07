const bytenode = require('bytenode');
const fs = require('fs');
const path = require('path');

// --- 您的配置区域 ---
// 您唯一需要维护的就是下面这个列表。
// 把所有需要被编译或复制到最终产品的顶层文件和文件夹的名字加到这里。
const itemsToProcess = [
    'app.js',
    'config.js',
    'license-validator.js',
    'manualSync.js',
    'nw.js',
    'unnw.js',
    'public_key.pem', // 非JS文件也会被自动复制
    'daemon',
    'db',
    'jobs',
    'router',
    'router_handler',
    'schema',
    'services',
    'uploads' // 根据您的目录，uploads也可能需要复制
];

// --- 脚本核心逻辑 (通常无需修改) ---
const projectRoot = __dirname;
const distDir = path.join(projectRoot, 'dist');

// 清理旧的 dist 目录
if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, {
        recursive: true,
        force: true
    });
}
fs.mkdirSync(distDir, {
    recursive: true
});

// 递归处理目录的函数
function processDirectory(srcDir, targetDir) {
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, {
            recursive: true
        });
    }
    const files = fs.readdirSync(srcDir);
    for (const file of files) {
        const srcPath = path.join(srcDir, file);
        const targetPath = path.join(targetDir, file);
        processPath(srcPath, targetPath);
    }
}

// 处理单个文件的函数
function processFile(srcPath, targetPath) {
    if (path.extname(srcPath) === '.js') {
        console.log(`---> ATTEMPTING TO COMPILE: ${srcPath}`);
        console.log(`Compiling: ${srcPath} -> ${targetPath.replace('.js', '.jsc')}`);
        bytenode.compileFile({
            filename: srcPath,
            output: targetPath.replace('.js', '.jsc'),
            electron: false,
        });
    } else {
        console.log(`Copying: ${srcPath} -> ${targetPath}`);
        fs.copyFileSync(srcPath, targetPath);
    }
}

// 根据路径是文件还是目录，选择不同处理方式
function processPath(srcPath, targetPath) {
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
        processDirectory(srcPath, targetPath);
    } else {
        processFile(srcPath, targetPath);
    }
}


// --- 脚本主入口 ---
console.log('Starting bytecode compilation based on your custom file list...');

itemsToProcess.forEach(item => {
    const srcPath = path.join(projectRoot, item);
    const distPath = path.join(distDir, item);
    if (fs.existsSync(srcPath)) {
        processPath(srcPath, distPath);
    } else {
        console.warn(`Warning: Item "${item}" not found in project root. Skipping.`);
    }
});

console.log('Compilation finished! Check the "dist" folder.');