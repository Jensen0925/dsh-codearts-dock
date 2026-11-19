#!/bin/bash
# 合规自检：每次发布前跑一遍
cd "$(dirname "$0")/.." 2>/dev/null || cd .
fail=0
chk(){ if eval "$2" >/dev/null 2>&1; then echo "✓ $1"; else echo "✗ $1"; fail=1; fi; }

echo '=== 法律与合规自检 ==='
chk 'LICENSE 存在且为 MIT'            'head -2 LICENSE | grep -q MIT'
chk 'DISCLAIMER.md 存在'              'test -f DISCLAIMER.md'
chk 'DISCLAIMER 声明无关联'           'grep -q "没有任何关联" DISCLAIMER.md'
chk 'DISCLAIMER 声明商标描述性使用'   'grep -q "描述性使用" DISCLAIMER.md'
chk 'DISCLAIMER 声明无担保'           'grep -qi "按原样" DISCLAIMER.md'
chk 'SECURITY.md 存在'                'test -f SECURITY.md'
chk 'README 顶部有非官方声明'         'head -12 README.md | grep -q "非官方"'
chk 'README 声明与华为无关联'         'head -12 README.md | grep -q "无任何关联"'
chk 'README 链到免责声明'             'grep -q "DISCLAIMER.md" README.md'
chk 'README 链到安全说明'             'grep -q "SECURITY.md" README.md'
chk 'THIRD_PARTY_NOTICES 存在'        'test -f THIRD_PARTY_NOTICES.md'
chk 'README 无逆向措辞'               '! grep -qiE "看内核源码|逆向工程|反编译" README.md'
chk 'README 声明不绕过计费'           'grep -q "不绕过计费" README.md'
chk '凭据借用声明仅本机本人'          'grep -q "本机" README.md && grep -q "本人" README.md'
chk '凭证文件权限 0600'               'grep -q "0o600" src/accounts.js'
chk '无第三方遥测域名'                '! grep -rqE "google-analytics\\.com|sentry\\.io|api\\.segment\\.io|mixpanel\\.com|posthog|amplitude" src/ client.js'
chk 'package.json 有 license 字段'    'grep -q "\"license\": \"MIT\"" package.json'
chk 'package.json 无死链接'           '! grep -qE "\"(repository|bugs|homepage)\"[^}]*github\\.com/Jensen0925/dsh-connect-codearts" package.json'
chk 'README 声明个人自用'             'head -14 README.md | grep -q "个人自用"'
chk 'README 声明未公开发布'           'head -14 README.md | grep -q "未公开发布"'
chk '新文档已列入 files'              'grep -q "DISCLAIMER.md" package.json && grep -q "SECURITY.md" package.json'
chk '.gitignore 排除凭证文件'         'grep -q "credentials.json" .gitignore'

echo
if [ $fail -eq 0 ]; then echo '全部通过。'; else echo '有未通过项，见上。'; fi
exit $fail
