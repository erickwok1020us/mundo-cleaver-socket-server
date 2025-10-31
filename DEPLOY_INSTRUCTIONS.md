# V428-All-Modes-Safe 部署說明 - 全模式高性能 + 自動保護

## 版本資訊
- **版本**: V428-All-Modes-Safe
- **發布日期**: 2025-01-30
- **類型**: 伺服器端更新（無遊戲內容修改）

## ✨ 新功能：自動保護機制

這個版本在 V428-All-Modes 基礎上添加了**智能自動保護**：

### 🛡️ 自動降級保護
- **監控指標**：事件循環延遲（p95）和利用率（ELU）
- **觸發條件**：p95 > 8ms 或 ELU > 90%（連續 3 次檢查）
- **保護動作**：自動將網絡廣播降到 30 Hz
- **恢復條件**：p95 < 6ms 且 ELU < 70%（連續 5 次檢查）
- **恢復動作**：自動回到 60 Hz 網絡廣播
- **物理更新**：**始終保持 125 Hz**（不影響遊戲邏輯）

### 📊 詳細性能監控
每 5 秒輸出一次完整指標：
- **基本指標**：Ticks/sec、Broadcasts/sec、AvgCatchUp、Clamps
- **事件循環**：p95 延遲（ms）、ELU 利用率（%）
- **階段耗時**：移動/飛刀/碰撞/廣播（微秒）
- **遊戲狀態**：玩家數（P）、飛刀數（K）、碰撞測試次數/秒
- **網絡狀態**：當前網絡頻率（60 Hz 或 30 Hz）、網絡字節/秒

## 已修改的內容（僅伺服器端）

### ✅ 更新率（所有模式）
1. **物理更新**：125 Hz（匹配客戶端 fixedDt = 0.008s）
2. **網絡廣播**：60 Hz（正常）/ 30 Hz（降級保護）
3. **高精度循環**：hrtime 納秒級精度
4. **獨立調度器**：物理和網絡分別調度

### ✅ 自動保護機制
1. **全局事件循環監控**：使用 perf_hooks
2. **每房間獨立降級**：只有負載高的房間降級
3. **滯後機制**：防止頻繁切換（3 次觸發 / 5 次恢復）
4. **物理不變**：125 Hz 物理更新永不改變

### ✅ 性能監控
1. **階段計時**：每個階段的納秒級計時
2. **碰撞計數**：追蹤 O(K×n) 壓力
3. **網絡採樣**：每 10 次廣播採樣一次大小
4. **完整日誌**：所有關鍵指標每 5 秒輸出

### ❌ 未修改的內容（遊戲邏輯完全不變）
- PLAYER_SPEED = 23.4 單位/秒
- KNIFE_SPEED = 4.5864 單位/秒
- COLLISION_RADIUS = 7.35
- 所有移動、碰撞、生命值邏輯
- 客戶端代碼（無需更新）

## 部署步驟

### 1. 備份當前版本
```bash
git add .
git commit -m "Backup before V428-All-Modes-Safe"
```

### 2. 上傳新文件
將以下文件上傳到你的後端倉庫：
- `gameEngine.js` - 全模式高性能遊戲引擎 + 自動保護
- `VERSION` - 版本記錄

### 3. 提交並推送
```bash
git add gameEngine.js VERSION
git commit -m "V428-All-Modes-Safe: 125Hz + 60Hz with auto-degradation protection"
git push origin main
```

### 4. Render 自動部署
- Render 會自動檢測到推送並開始部署
- 等待部署完成（通常 2-3 分鐘）
- **立即開始監控日誌**

### 5. 驗證部署
訪問你的後端 URL 的 health 端點：
```
https://your-backend.onrender.com/health
```

## 測試指南

### 1. 測試 1v1 模式
創建 1v1 房間，日誌應該顯示：
```
[GAME-ENGINE] Event loop monitoring initialized
[GAME-ENGINE] Room XXXX initialized - Mode: 1v1, Tick Rate: 125 Hz, Network Rate: 60 Hz
[GAME-ENGINE] Starting HIGH-PERFORMANCE game loop for room XXXX (1v1) - Physics: 125 Hz, Network: 60 Hz
[GAME-ENGINE] Room XXXX - Ticks/sec: 125.0, Broadcasts/sec: 60.0, AvgCatchUp: 1.00, Clamps: 0 | EL p95: 3.45ms, ELU: 45.2% | PhaseUs (move/knives/colls/bcast): 12.34/23.45/34.56/45.67 | P: 2, K: 1, CollTests/sec: 250, NetRate: 60Hz, NetBytes/sec: ~1234
```

### 2. 測試 3v3 模式（關鍵）
創建 3v3 房間，日誌應該顯示：
```
[GAME-ENGINE] Room YYYY initialized - Mode: 3v3, Tick Rate: 125 Hz, Network Rate: 60 Hz
[GAME-ENGINE] Starting HIGH-PERFORMANCE game loop for room YYYY (3v3) - Physics: 125 Hz, Network: 60 Hz
[GAME-ENGINE] Room YYYY - Ticks/sec: 125.0, Broadcasts/sec: 60.0, AvgCatchUp: 1.00, Clamps: 0 | EL p95: 5.67ms, ELU: 65.3% | PhaseUs (move/knives/colls/bcast): 15.23/28.34/67.89/52.11 | P: 6, K: 3, CollTests/sec: 2250, NetRate: 60Hz, NetBytes/sec: ~3456
```

### 3. 測試自動降級（如果觸發）
如果伺服器負載過高，你會看到：
```
[GAME-ENGINE] Room YYYY AUTO-DEGRADE: network -> 30 Hz (EL p95=9.23ms, ELU=92.5%)
[GAME-ENGINE] Room YYYY - Ticks/sec: 125.0, Broadcasts/sec: 30.0, ... | NetRate: 30Hz, ...
```

然後負載恢復後：
```
[GAME-ENGINE] Room YYYY RECOVER: network -> 60 Hz (EL p95=5.12ms, ELU=68.3%)
[GAME-ENGINE] Room YYYY - Ticks/sec: 125.0, Broadcasts/sec: 60.0, ... | NetRate: 60Hz, ...
```

### 4. 監控性能指標（每 5 秒）

**健康指標（正常運行）：**
- ✅ Ticks/sec: 124-126（接近 125）
- ✅ Broadcasts/sec: 59-61（正常）或 29-31（降級）
- ✅ AvgCatchUp: 1.00-1.10（正常）
- ✅ Clamps: 0-2（偶爾 GC 暫停）
- ✅ EL p95: < 8ms（健康）
- ✅ ELU: < 90%（健康）
- ✅ NetRate: 60Hz（正常）或 30Hz（自動保護中）

**警告指標（輕微壓力）：**
- ⚠️ Ticks/sec: 120-124（輕微延遲）
- ⚠️ AvgCatchUp: 1.10-1.30（頻繁追趕）
- ⚠️ EL p95: 8-10ms（接近閾值）
- ⚠️ ELU: 85-95%（高利用率）
- ⚠️ 可能觸發自動降級到 30 Hz

**自動保護觸發（系統自救）：**
- 🛡️ NetRate: 30Hz（自動降級保護中）
- 🛡️ Ticks/sec: 仍然 125（物理不變）
- 🛡️ Broadcasts/sec: 30（減少網絡壓力）
- 🛡️ 遊戲仍然流暢，只是網絡更新稍慢

**危險指標（需要回滾）：**
- ❌ Ticks/sec: < 115（嚴重延遲，自動保護失效）
- ❌ AvgCatchUp: > 1.50（持續追趕）
- ❌ Clamps: > 20（持續限制）
- ❌ EL p95: > 15ms（嚴重延遲）
- ❌ 即使降級到 30 Hz 也無法穩定

### 5. 理解日誌指標

**PhaseUs (move/knives/colls/bcast)**：
- move: 移動更新耗時（微秒）
- knives: 飛刀更新耗時（微秒）
- colls: 碰撞檢測耗時（微秒）← **通常是瓶頸**
- bcast: 網絡廣播耗時（微秒）

**CollTests/sec**：
- 每秒碰撞測試次數
- 1v1: 約 250-500（2 個玩家 × 1-2 把刀 × 125 Hz）
- 3v3: 約 2000-4000（6 個玩家 × 3-6 把刀 × 125 Hz）
- 如果這個數字很高且 colls 耗時也高，說明碰撞是瓶頸

## 故障排除

### 問題 1：自動降級頻繁觸發
**症狀**：
```
[GAME-ENGINE] Room YYYY AUTO-DEGRADE: network -> 30 Hz (EL p95=9.23ms, ELU=92.5%)
```

**原因**：伺服器 CPU 不足以處理 125 Hz + 60 Hz

**這是正常的！** 自動保護機制正在工作：
- 物理仍然是 125 Hz（遊戲邏輯不變）
- 網絡降到 30 Hz（減少壓力）
- 遊戲仍然可玩，只是網絡更新稍慢

**如果想避免降級：**
1. 升級 Render 計劃以獲得更多 CPU
2. 或接受偶爾降級（這是設計的保護機制）

### 問題 2：即使降級到 30 Hz 仍然卡頓
**症狀**：
```
[GAME-ENGINE] Room YYYY - Ticks/sec: 110.5, ... | NetRate: 30Hz, ...
```

**原因**：伺服器 CPU 嚴重不足，連 125 Hz 物理都跑不動

**解決方案：**
1. **立即回滾**到 V427（60 Hz 物理 + 30 Hz 網絡）
2. 或升級到更高的 Render 計劃
3. 或使用 V428（僅 1v1 啟用 125 Hz）

### 問題 3：日誌顯示 colls 耗時很高
**症狀**：
```
PhaseUs (move/knives/colls/bcast): 10.23/15.34/150.67/45.23
```
（colls 耗時 150 微秒，遠高於其他階段）

**原因**：碰撞檢測是 O(K×n)，玩家和飛刀多時成為瓶頸

**這是預期的！** 這就是為什麼我們需要監控：
- 自動降級會減少網絡壓力
- 如果需要，未來可以優化碰撞檢測（broadphase）
- 但這不影響遊戲邏輯，只是性能優化

### 問題 4：遊戲仍然卡頓
**可能原因：**
1. 伺服器性能不足（檢查 Ticks/sec 和 EL p95）
2. 網絡延遲波動（檢查延遲顯示）
3. 客戶端問題（檢查客戶端日誌）

**調試步驟：**
1. 分享 60 秒的伺服器日誌（包含完整指標）
2. 報告具體哪個模式卡頓（1v1 還是 3v3）
3. 檢查是否觸發了自動降級
4. 檢查 colls 耗時是否異常高

## 性能基準

### 1v1 模式（2 個玩家）
- 物理更新：125 Hz ± 1 Hz
- 網絡廣播：60 Hz ± 1 Hz（正常）
- 事件循環 p95：< 5ms
- ELU：< 60%
- 碰撞測試：250-500 次/秒
- 自動降級：**不應觸發**

### 3v3 模式（6 個玩家）
- 物理更新：125 Hz ± 2 Hz
- 網絡廣播：60 Hz ± 1 Hz（正常）或 30 Hz（降級）
- 事件循環 p95：5-8ms（可能稍高）
- ELU：60-85%（可能稍高）
- 碰撞測試：2000-4000 次/秒
- 自動降級：**可能偶爾觸發**（這是正常的保護機制）

## 回滾指南

### 快速回滾到 V427
```bash
git revert HEAD
git push origin main
```

### 或手動恢復
```bash
git checkout HEAD~1 gameEngine.js VERSION
git commit -m "Rollback to V427"
git push origin main
```

## 下一步

部署後**立即**：
1. 監控日誌 60 秒（1v1 模式）
2. 監控日誌 60 秒（3v3 模式）
3. 分享兩個模式的完整日誌（包含所有指標）
4. 報告：
   - 遊戲流暢度
   - 是否觸發自動降級
   - colls 耗時是否異常高
   - 飛刀命中是否準確

**如果自動降級頻繁觸發：**
- 這是正常的！系統正在保護自己
- 遊戲仍然可玩（物理 125 Hz 不變）
- 如果想避免，考慮升級 Render 計劃

**如果即使降級也卡頓：**
- 回滾到 V427 或 V428（僅 1v1）
- 分享日誌以便分析

**如果一切正常：**
- 恭喜！你現在有最高性能 + 智能保護的遊戲伺服器
- 繼續監控長期穩定性
- 觀察自動降級/恢復機制是否正常工作

---

**重要提醒**：自動降級是**保護機制**，不是錯誤。如果觸發，說明系統正在自救，避免崩潰。
