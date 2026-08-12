# CPU (Web audit Module)

CPU module for web_audit.


## Install
1. Install with your favorite package manager
2. Add the module in yout web-audit.config.js 
```
export const config = {
	modules: [
        ...
        'node_modules/web-audit-module-cpu/src/modules/CpuModule.js'
    ],
},
```
3. By default, the historic details are not logged. You can enable historic with the following configuration in you web-aduit.config.js file : 
```
export const config = {
	...
    cpu: {
        history: true,
    }
```

## Configuration
By default, the sampling delay is 100ms, but you can choose a different one in the web-audit.config.js file :
```
export const config = {
	...
    cpu: {
        ...
        sampling: 100,
    }
```
