# docs/requirements —— 需求档案

> 每个需求一个文件，记录背景 → 目标 → 方案 → 验收 → 遗留，并与 git 分支关联。

## 规则

### 文件命名

格式：`docs/requirements/<id>-<slug>.md`

id 规则（对齐上游规范）：
- 格式：`YYMMDD-<6位base36随机>`
- 生成：`node -e "const d=new Date(),p=n=>String(n).padStart(2,`0`);console.log(String(d.getFullYear()).slice(2)+p(d.getMonth()+1)+p(d.getDate())+`-`+Math.random().toString(36).slice(2,8))"`

### 文档结构（固定）
文件头部是 YAML frontmatter：

```yaml
---
id: 261110-a3f9k2
type: feature
title: 功能标题
status: draft
branch: feat/261110-a3f9k2
created: 2026-11-10
updated: 2026-11-10
---
```

正文固定五节：背景 / 目标 / 方案 / 验收标准 / 遗留。

### 分支关联
分支名必须含需求 ID：`<type>/<id>-<slug>`

### 代码注释关联档案
只在「决策点」和「反直觉处」加。前缀约定：

| 前缀 | 场景 |
|---|---|
| `[id]` | 新增代码 |
| `[id-mod]` | 修改现有代码 |
| `[id-fix]` | 纯 bug 修复 |

格式：`// [id] 一句话说清做了什么 + 为什么。详见 docs/requirements/xxx.md`

### INDEX.md
INDEX.md 是自动生成的，不要手改。运行 `node scripts/build-docs-index.mjs` 更新。
