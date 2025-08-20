//uninstall.js

import path from 'path'
import nodeWindow from 'node-windows'
const Service = nodeWindow.Service

let svc = new Service({
    name: 'node_database', //名称
    script: path.resolve('./app.js'), //node执行入口文件
    nodeOptions: [
        '--harmony',
        '--max_old_space_size=4096'
    ]
});

svc.on('uninstall', function () {
    if (!svc.exists) {
        console.log('服务卸载完成');
    }
});

svc.uninstall();