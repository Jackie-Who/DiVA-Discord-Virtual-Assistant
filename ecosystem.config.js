export default {
    apps: [{
        name: 'diva',
        script: 'src/index.js',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '400M',
        env: {
            NODE_ENV: 'production'
        },
        error_file: './logs/error.log',
        out_file: './logs/output.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }]
};
