/**
 * DX3rd Move Enhancement Module
 * 토큰 이동을 감지하고 월드 레벨 설정에 저장합니다.
 */

// 전역 이동 순서 카운터
let moveOrderCounter = 0;

// 이동 취소 중 플래그 (updateToken 훅 스킵용)
let isUndoingMove = false;

// 경로 그래픽 객체 (선택된 토큰과 호버된 토큰 분리)
let controlledPathGraphics = null;
let hoveredPathGraphics = null;

/**
 * 이동 기록 윈도우 클래스
 */
class MoveHistoryWindow extends foundry.applications.api.HandlebarsApplicationMixin(
    foundry.applications.api.ApplicationV2
) {
    static DEFAULT_OPTIONS = {
        id: 'move-history-window',
        tag: 'div',
        window: {
            title: '이동 기록',
            resizable: false,
            minimizable: false,
            controls: []  // x 버튼 숨김
        },
        classes: ['move-history-application'],
        position: {
            width: 380,
            height: 280
        },
        actions: {
            'undo-move': MoveHistoryWindow._onUndoMove,
            'clear-history': MoveHistoryWindow._onClearHistory
        }
    };
    
    /**
     * 이동 취소 버튼 클릭
     */
    static async _onUndoMove(event, target) {
        await undoLastMoveGroup();
        
        // 창 새로고침
        if (game.moveHistoryWindow?.rendered) {
            game.moveHistoryWindow.render();
        }
        
        // 선택된 토큰의 경로 업데이트
        const controlled = canvas.tokens?.controlled;
        if (controlled && controlled.length > 0) {
            console.log('취소 후 경로 업데이트');
            drawMovementPath(controlled[0].document, 'controlled');
        } else {
            // 선택된 토큰이 없으면 경로 제거
            clearMovementPath('controlled');
        }
    }
    
    /**
     * 기록 삭제 버튼 클릭
     */
    static async _onClearHistory(event, target) {
        // GM이면 직접 삭제, 아니면 소켓으로 요청
        if (game.user.isGM) {
            await game.settings.set('lichsoma-dx3rd-move-enhancement', 'moveHistory', []);
            console.log('✓ 모든 이동 기록 삭제 완료');
        } else {
            game.socket.emit('module.lichsoma-dx3rd-move-enhancement', {
                action: 'setMoveHistory',
                history: []
            });
        }
        
        ui.notifications.info('모든 이동 기록이 삭제되었습니다');
        
        // 창 새로고침
        if (game.moveHistoryWindow?.rendered) {
            game.moveHistoryWindow.render();
        }
    }

    static PARTS = {
        window: {
            template: 'modules/lichsoma-dx3rd-move-enhancement/templates/move-history-window.html'
        }
    };

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        
        // 월드에서 이동 기록 가져오기
        const allMoves = getWorldMoveHistory();
        
        console.log('전체 이동 기록:', allMoves);
        
        // moveOrder로 정렬
        const sortedMoves = [...allMoves].sort((a, b) => a.moveOrder - b.moveOrder);
        
        // 연속된 같은 토큰의 이동을 그룹화
        const groups = [];
        let currentGroup = null;
        
        for (const move of sortedMoves) {
            // 현재 그룹이 없거나, 다른 토큰이면 새 그룹 시작
            if (!currentGroup || currentGroup.tokenId !== move.tokenId) {
                if (currentGroup) {
                    groups.push(currentGroup);
                }
                currentGroup = {
                    tokenId: move.tokenId,
                    tokenName: move.tokenName,
                    sceneId: move.sceneId,
                    sceneName: move.sceneName,
                    firstMoveOrder: move.moveOrder,
                    lastMoveOrder: move.moveOrder,
                    from: move.from,  // 첫 출발점
                    to: move.to,      // 현재 도착점 (계속 업데이트됨)
                    moveCount: 1
                };
            } else {
                // 같은 토큰이면 그룹에 추가
                currentGroup.lastMoveOrder = move.moveOrder;
                currentGroup.to = move.to;  // 도착점 업데이트
                currentGroup.moveCount++;
            }
        }
        
        // 마지막 그룹 추가
        if (currentGroup) {
            groups.push(currentGroup);
        }
        
        console.log('그룹화된 이동 기록:', groups);
        
        context.moveGroups = groups;
        context.hasHistory = groups.length > 0;
        
        // 기록 삭제는 GM만 가능
        context.canClearHistory = game.user.isGM;
        
        // 이동 취소는 마지막 이동이 자신이 컨트롤할 수 있는 토큰일 때만 가능
        context.canUndoMove = false;
        if (groups.length > 0) {
            const lastGroup = groups[groups.length - 1];
            const scene = game.scenes.get(lastGroup.sceneId);
            const tokenDoc = scene?.tokens.get(lastGroup.tokenId);
            if (tokenDoc) {
                context.canUndoMove = tokenDoc.canUserModify(game.user, 'update');
            }
        }
        
        console.log('권한:', { canClearHistory: context.canClearHistory, canUndoMove: context.canUndoMove });
        
        return context;
    }
}

/**
 * 월드 설정에서 이동 기록 가져오기
 */
function getWorldMoveHistory() {
    return game.settings.get('lichsoma-dx3rd-move-enhancement', 'moveHistory') || [];
}

/**
 * 이동 경로 그리기 (거리에 따라 색상 구분)
 * @param {TokenDocument} tokenDoc - 토큰 문서
 * @param {string} pathType - 'controlled' 또는 'hovered'
 */
function drawMovementPath(tokenDoc, pathType = 'controlled') {
    if (!tokenDoc || !canvas.ready) return;
    
    // 기존 경로 제거 (해당 타입만)
    clearMovementPath(pathType);
    
    // 현재 장면의 해당 토큰 이동 기록 가져오기
    const history = getWorldMoveHistory();
    const tokenMoves = history.filter(m => 
        m.tokenId === tokenDoc.id && 
        m.sceneId === tokenDoc.parent.id
    );
    
    if (tokenMoves.length === 0) {
        console.log('표시할 이동 기록 없음:', tokenDoc.name);
        return;
    }
    
    // moveOrder로 정렬
    const sortedMoves = [...tokenMoves].sort((a, b) => a.moveOrder - b.moveOrder);
    
    console.log(`경로 그리기 (${pathType}):`, tokenDoc.name, sortedMoves.length, '개 이동');
    
    // 액터의 이동력 가져오기
    const actor = tokenDoc.actor;
    const battleMove = actor?.system?.attributes?.move?.battle || 0;
    const fullMove = actor?.system?.attributes?.move?.full || 0;
    
    console.log('이동력:', { battle: battleMove, full: fullMove });
    
    // PIXI Graphics 생성
    const graphics = new PIXI.Graphics();
    
    // 토큰 크기 가져오기
    const tokenWidth = tokenDoc.width * canvas.grid.size;
    const tokenHeight = tokenDoc.height * canvas.grid.size;
    
    // 누적 이동 거리 (그리드 단위)
    let cumulativeDistance = 0;
    
    // 모든 이동 경로 그리기
    for (const move of sortedMoves) {
        // 출발점과 도착점의 중심 계산
        const fromCenter = {
            x: move.from.x + tokenWidth / 2,
            y: move.from.y + tokenHeight / 2
        };
        const toCenter = {
            x: move.to.x + tokenWidth / 2,
            y: move.to.y + tokenHeight / 2
        };
        
        // 이동 거리 계산 (그리드 단위, 맨해튼 거리)
        const dx = Math.abs(move.to.x - move.from.x) / canvas.grid.size;
        const dy = Math.abs(move.to.y - move.from.y) / canvas.grid.size;
        const distance = dx + dy;
        
        cumulativeDistance += distance;
        
        // 거리에 따라 색상 결정 (도착점 기준)
        let color;
        if (cumulativeDistance <= battleMove) {
            color = 0x00FF00;  // 녹색
        } else if (cumulativeDistance <= fullMove) {
            color = 0xFFFF00;  // 노란색
        } else {
            color = 0xFF0000;  // 빨간색
        }
        
        console.log(`이동 ${move.moveOrder}: 거리 ${distance.toFixed(1)}, 누적 ${cumulativeDistance.toFixed(1)}, 색상 ${color.toString(16)}`);
        
        // 선 그리기 (색상은 도착점 기준)
        graphics.lineStyle(6, color, 0.25);
        graphics.moveTo(fromCenter.x, fromCenter.y);
        graphics.lineTo(toCenter.x, toCenter.y);
    }
    
    // 캔버스에 추가
    canvas.primary.addChild(graphics);
    
    // 타입에 따라 저장
    if (pathType === 'controlled') {
        controlledPathGraphics = graphics;
    } else {
        hoveredPathGraphics = graphics;
    }
    
    console.log('경로 그리기 완료, 총 누적 거리:', cumulativeDistance.toFixed(1));
}

/**
 * 이동 경로 제거
 * @param {string} pathType - 'controlled', 'hovered', 또는 'all'
 */
function clearMovementPath(pathType = 'all') {
    if (pathType === 'controlled' || pathType === 'all') {
        if (controlledPathGraphics) {
            controlledPathGraphics.parent?.removeChild(controlledPathGraphics);
            controlledPathGraphics.destroy();
            controlledPathGraphics = null;
            console.log('선택 경로 제거 완료');
        }
    }
    
    if (pathType === 'hovered' || pathType === 'all') {
        if (hoveredPathGraphics) {
            hoveredPathGraphics.parent?.removeChild(hoveredPathGraphics);
            hoveredPathGraphics.destroy();
            hoveredPathGraphics = null;
            console.log('호버 경로 제거 완료');
        }
    }
}

/**
 * 월드 설정에 이동 기록 저장 (GM만 가능)
 */
async function saveWorldMoveHistory(moveData) {
    // GM이 아니면 소켓으로 GM에게 요청
    if (!game.user.isGM) {
        game.socket.emit('module.lichsoma-dx3rd-move-enhancement', {
            action: 'saveMoveHistory',
            moveData: moveData
        });
        return;
    }
    
    // GM이면 직접 저장
    const history = getWorldMoveHistory();
    history.push(moveData);
    await game.settings.set('lichsoma-dx3rd-move-enhancement', 'moveHistory', history);
    console.log('✓ 월드에 이동 기록 저장 완료:', moveData);
}

/**
 * 마지막 이동 그룹 취소
 */
async function undoLastMoveGroup() {
    const history = getWorldMoveHistory();
    if (history.length === 0) {
        ui.notifications.warn('취소할 이동이 없습니다');
        return;
    }
    
    // 이동 취소 플래그 설정 (updateToken 훅 스킵)
    isUndoingMove = true;
    
    try {
        // moveOrder로 정렬하여 마지막 그룹 찾기
        const sortedMoves = [...history].sort((a, b) => a.moveOrder - b.moveOrder);
        
        // 마지막 이동의 토큰으로 마지막 그룹 찾기
        const lastMove = sortedMoves[sortedMoves.length - 1];
        const lastGroupMoves = [];
        
        // 뒤에서부터 같은 토큰의 연속된 이동 찾기
        for (let i = sortedMoves.length - 1; i >= 0; i--) {
            const move = sortedMoves[i];
            if (move.tokenId === lastMove.tokenId) {
                lastGroupMoves.unshift(move);
            } else {
                break;  // 다른 토큰이 나오면 중단
            }
        }
        
        console.log('취소할 그룹:', lastGroupMoves);
        
        // 토큰을 그룹의 첫 출발점으로 이동
        const firstMove = lastGroupMoves[0];
        const scene = game.scenes.get(firstMove.sceneId);
        const tokenDoc = scene?.tokens.get(firstMove.tokenId);
        
        if (!tokenDoc) {
            ui.notifications.error('토큰을 찾을 수 없습니다');
            return;
        }
        
        // 토큰 이동 (애니메이션 없이)
        await tokenDoc.update({
            x: firstMove.from.x,
            y: firstMove.from.y
        }, { animate: false });
        
        // FVTT 내장 이동 기록 삭제
        await tokenDoc.clearMovementHistory();
        
        // 월드 설정에서 해당 그룹의 모든 이동 삭제
        const moveOrdersToDelete = lastGroupMoves.map(m => m.moveOrder);
        const newHistory = history.filter(m => !moveOrdersToDelete.includes(m.moveOrder));
        
        // GM이면 직접 저장, 아니면 소켓으로 요청
        if (game.user.isGM) {
            await game.settings.set('lichsoma-dx3rd-move-enhancement', 'moveHistory', newHistory);
            console.log('✓ 이동 취소 완료, 남은 기록:', newHistory.length);
        } else {
            game.socket.emit('module.lichsoma-dx3rd-move-enhancement', {
                action: 'setMoveHistory',
                history: newHistory
            });
        }
        
        ui.notifications.info('이동이 취소되었습니다');
    } finally {
        // 플래그 해제
        isUndoingMove = false;
    }
}

Hooks.once('init', async function() {
    console.log('DX3rd Move Enhancement | Initializing...');
    
    // 월드 레벨 설정 등록 (이동 기록 저장용)
    game.settings.register('lichsoma-dx3rd-move-enhancement', 'moveHistory', {
        name: 'Move History',
        scope: 'world',
        config: false,
        type: Array,
        default: [],
        onChange: (value) => {
            console.log('moveHistory 설정 변경 감지, 총', value.length, '개 이동');
            
            // 이동 기록 창이 열려있으면 업데이트
            if (game.moveHistoryWindow?.rendered) {
                console.log('설정 변경으로 인한 이동 기록 창 업데이트');
                game.moveHistoryWindow.render();
            }
            
            // 선택된 토큰이 있으면 경로 다시 그리기
            const controlled = canvas.tokens?.controlled;
            if (controlled && controlled.length > 0) {
                console.log('설정 변경으로 인한 경로 업데이트:', controlled[0].document.name);
                drawMovementPath(controlled[0].document, 'controlled');
            }
        }
    });
    
    // 소켓 핸들러 등록 (GM만 실행)
    game.socket.on('module.lichsoma-dx3rd-move-enhancement', async (data) => {
        if (!game.user.isGM) return;
        
        console.log('Socket received:', data);
        
        try {
            switch (data.action) {
                case 'saveMoveHistory': {
                    const history = getWorldMoveHistory();
                    history.push(data.moveData);
                    await game.settings.set('lichsoma-dx3rd-move-enhancement', 'moveHistory', history);
                    console.log('✓ GM이 월드에 이동 기록 저장:', data.moveData);
                    break;
                }
                
                case 'setMoveHistory': {
                    await game.settings.set('lichsoma-dx3rd-move-enhancement', 'moveHistory', data.history);
                    console.log('✓ GM이 이동 기록 업데이트:', data.history.length);
                    break;
                }
            }
        } catch (error) {
            console.error('Socket handler error:', error);
        }
    });
});

Hooks.once('ready', async function() {
    console.log('DX3rd Move Enhancement | Ready');
    
    // 카운터 초기화 (월드에 저장된 기록 기준)
    const history = getWorldMoveHistory();
    if (history.length > 0) {
        moveOrderCounter = Math.max(...history.map(m => m.moveOrder || 0));
    }
    console.log('이동 카운터 초기화:', moveOrderCounter);
});

/**
 * Scene Controls에 이동 기록 토글 버튼 추가 (v13: controls는 객체)
 */
Hooks.on('getSceneControlButtons', (controls) => {
    const tokenControls = controls.tokens;
    if (!tokenControls) return;

    // v13: tools는 객체이므로 속성으로 추가
    tokenControls.tools['show-move-history'] = {
        name: 'show-move-history',
        title: '이동 기록',
        icon: 'fas fa-route',
        button: true,
        onClick: () => {
            // 창 열기 (이미 열려있으면 포커스)
            if (!game.moveHistoryWindow) {
                game.moveHistoryWindow = new MoveHistoryWindow();
            }
            game.moveHistoryWindow.render(true, { focus: true });
        }
    };
});

/**
 * 토큰 선택 시 이동 경로 표시
 */
Hooks.on('controlToken', (token, controlled) => {
    if (controlled) {
        // 토큰 선택 시 경로 표시
        drawMovementPath(token.document, 'controlled');
    } else {
        // 토큰 해제 시 경로 제거
        clearMovementPath('controlled');
    }
});

/**
 * 토큰 호버 시 이동 경로 표시
 */
Hooks.on('hoverToken', (token, hovered) => {
    if (hovered) {
        // 호버 시 경로 표시
        drawMovementPath(token.document, 'hovered');
    } else {
        // 언호버 시 경로 제거
        clearMovementPath('hovered');
    }
});

/**
 * 전투 종료 시 이동 기록 삭제
 */
Hooks.on('deleteCombat', async (combat, options, userId) => {
    // GM만 처리
    if (!game.user.isGM) return;
    
    console.log('전투 종료 감지:', combat.id);
    
    // 이동 기록 삭제
    await game.settings.set('lichsoma-dx3rd-move-enhancement', 'moveHistory', []);
    console.log('✓ 전투 종료로 인한 이동 기록 삭제 완료');
    
    // 이동 카운터 초기화
    moveOrderCounter = 0;
    
    // 모든 경로 제거
    clearMovementPath('all');
    
    ui.notifications.info('전투 종료: 모든 이동 기록이 삭제되었습니다');
});

/**
 * 라운드 변경 시 이동 기록 삭제
 */
Hooks.on('updateCombat', async (combat, changes, options, userId) => {
    // GM만 처리
    if (!game.user.isGM) return;
    
    // 라운드 변경 체크
    if (changes.round !== undefined) {
        console.log('라운드 변경 감지:', changes.round);
        
        // 이동 기록 삭제
        await game.settings.set('lichsoma-dx3rd-move-enhancement', 'moveHistory', []);
        console.log('✓ 라운드 변경으로 인한 이동 기록 삭제 완료');
        
        // 이동 카운터 초기화 (라운드마다 #1부터 시작)
        moveOrderCounter = 0;
        
        // 모든 경로 제거
        clearMovementPath('all');
        
        ui.notifications.info(`라운드 ${changes.round}: 이동 기록이 초기화되었습니다`);
    }
});

/**
 * 이니셔티브 프로세스 시작 시 이동 기록 삭제 (DX3rd 시스템)
 */
Hooks.on('createChatMessage', async (message, options, userId) => {
    // GM만 처리
    if (!game.user.isGM) return;
    
    // 이니셔티브 프로세스 메시지인지 확인
    const initiativeProcessMsg = game.i18n?.localize('DX3rd.InitiativeProcess');
    if (!initiativeProcessMsg) return;
    
    // 메시지 내용에 "이니셔티브 프로세스"가 포함되어 있는지 확인
    if (message.content?.includes(initiativeProcessMsg)) {
        console.log('이니셔티브 프로세스 감지');
        
        // 이동 기록 삭제
        await game.settings.set('lichsoma-dx3rd-move-enhancement', 'moveHistory', []);
        console.log('✓ 이니셔티브 프로세스 실행으로 인한 이동 기록 삭제 완료');
        
        // 이동 카운터 초기화
        moveOrderCounter = 0;
        
        // 모든 경로 제거
        clearMovementPath('all');
    }
});

/**
 * 토큰 이동 감지 및 처리
 */
Hooks.on('updateToken', async (tokenDoc, changes, options, userId) => {
    // 이동 취소 중이면 스킵
    if (isUndoingMove) {
        console.log('이동 취소 중 - updateToken 훅 스킵');
        return;
    }
    
    // x, y 좌표 변경이 없으면 무시
    if (!changes.x && !changes.y) return;
    
    // 이동 기록이 없으면 무시
    const history = tokenDoc.movementHistory;
    if (!history || history.length === 0) return;
    
    // ===== GM만 저장 처리 =====
    if (game.user.isGM) {
        // 전투 중이 아니면 기록하지 않음
        if (!game.combat) {
            console.log('전투 중이 아님 - 이동 기록 생략:', tokenDoc.name);
            await tokenDoc.clearMovementHistory();
            return;
        }
        
        // 출발점과 도착점 계산
        const from = history[0];  // 첫 번째 웨이포인트 = 출발점
        const to = history[history.length - 1];  // 마지막 웨이포인트 = 도착점
        
        // 이동 순서 증가
        moveOrderCounter++;
        
        // 이동 데이터 구성
        const moveData = {
            tokenId: tokenDoc.id,
            tokenName: tokenDoc.name,
            sceneId: tokenDoc.parent.id,
            sceneName: tokenDoc.parent.name,
            from: { x: from.x, y: from.y },
            to: { x: to.x, y: to.y },
            timestamp: Date.now(),
            moveOrder: moveOrderCounter
        };
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`토큰 이동 감지: ${tokenDoc.name}`);
        console.log('이동 기록:', history);
        console.log('이동 경로:');
        
        for (let i = 0; i < history.length; i++) {
            const waypoint = history[i];
            console.log(`  웨이포인트 ${i + 1}: (${waypoint.x}, ${waypoint.y})`);
        }
        
        console.log('저장할 데이터:', moveData);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        // 월드에 이동 기록 저장 (GM이 직접)
        const worldHistory = getWorldMoveHistory();
        worldHistory.push(moveData);
        await game.settings.set('lichsoma-dx3rd-move-enhancement', 'moveHistory', worldHistory);
        console.log('✓ GM이 월드에 이동 기록 저장:', moveData);
        
        // FVTT 내장 이동 기록 삭제
        await tokenDoc.clearMovementHistory();
        console.log(`${tokenDoc.name}의 FVTT 이동 기록 삭제 완료`);
    }
    
    // ===== 모든 클라이언트: UI 업데이트 =====
    // 이동 기록 창이 열려있으면 실시간 업데이트
    if (game.moveHistoryWindow?.rendered) {
        console.log('이동 기록 창 실시간 업데이트');
        game.moveHistoryWindow.render();
    }
    
    // 선택된 토큰이면 경로 다시 그리기 (즉시 업데이트)
    const token = tokenDoc.object;
    if (token?.controlled) {
        console.log('선택된 토큰 경로 업데이트:', tokenDoc.name);
        drawMovementPath(tokenDoc, 'controlled');
    }
});
