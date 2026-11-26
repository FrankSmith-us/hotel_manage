# Git 自动提交与推送规则

## 触发时机
- 每次完成涉及代码、配置或文档修改的开发任务并验证通过后，自动执行 Git 提交与推送。
- 仅进行问答或只读排查且无文件变更时，不执行提交。

## 提交流程
1. 运行 `git status` 检查变更文件，确保不包含敏感信息（如 `.env`、密钥、Token）或无关临时文件。
2. 执行 `git add -A` 暂存变更。
3. 使用清晰简洁的 Conventional Commits 风格提交信息执行 `git commit -m "<type>: <description>"`（例如 `feat: ...`、`fix: ...`、`chore: ...`、`docs: ...`）。
4. 检查是否已配置 `origin` 远程仓库（`git remote get-url origin`）：
   - 若已配置，执行 `git push -u origin HEAD` 推送到 GitHub（如因网络沙箱受限，提示或申请放行后推送）。
   - 若尚未配置 `origin`，仅保留本地提交，并在回复中提醒用户关联 GitHub 远程仓库。

## 安全约束
- 严禁未经用户明确同意执行 `git push --force` 或重写已推送的提交历史。
- 若推送因冲突或鉴权失败，停止重试并向用户报告具体原因。
