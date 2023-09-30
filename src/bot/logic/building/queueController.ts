import {
    ActionsApi,
    GameApi,
    PlayerData,
    ProductionApi,
    QueueStatus,
    QueueType,
    TechnoRules,
} from "@chronodivide/game-api";
import { GlobalThreat } from "../threat/threat";
import {
    TechnoRulesWithPriority,
    BUILDING_NAME_TO_RULES,
    DEFAULT_BUILDING_PRIORITY,
    getDefaultPlacementLocation,
} from "./building.js";

export const queueTypeToName = (queue: QueueType) => {
    switch (queue) {
        case QueueType.Structures:
            return "Structures";
        case QueueType.Armory:
            return "Armory";
        case QueueType.Infantry:
            return "Infantry";
        case QueueType.Vehicles:
            return "Vehicles";
        case QueueType.Aircrafts:
            return "Aircrafts";
        case QueueType.Ships:
            return "Ships";
        default:
            return "Unknown";
    }
};

export class QueueController {
    public onAiUpdate(
        game: GameApi,
        productionApi: ProductionApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        threatCache: GlobalThreat | undefined,
        logger: (message: string) => void
    ) {
        const queues = [
            QueueType.Structures,
            QueueType.Armory,
            QueueType.Infantry,
            QueueType.Vehicles,
            QueueType.Aircrafts,
            QueueType.Ships,
        ];
        const decisions = queues
            .map((queueType) => {
                const options = productionApi.getAvailableObjects(queueType);
                return {
                    queue: queueType,
                    decision: this.getBestOptionForBuilding(game, options, threatCache, playerData, false, logger),
                };
            })
            .filter((decision) => decision.decision != null);
        let totalWeightAcrossQueues = decisions
            .map((decision) => decision.decision?.priority!)
            .reduce((pV, cV) => pV + cV, 0);
        let totalCostAcrossQueues = decisions
            .map((decision) => decision.decision?.unit.cost!)
            .reduce((pV, cV) => pV + cV, 0);

        decisions.forEach((decision) => {
            this.updateBuildQueue(
                game,
                productionApi,
                actionsApi,
                playerData,
                threatCache,
                decision.queue,
                decision.decision,
                totalWeightAcrossQueues,
                totalCostAcrossQueues,
                logger
            );
        });
    }

    private updateBuildQueue(
        game: GameApi,
        productionApi: ProductionApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        threatCache: GlobalThreat | undefined,
        queueType: QueueType,
        decision: TechnoRulesWithPriority | undefined,
        totalWeightAcrossQueues: number,
        totalCostAcrossQueues: number,
        logger: (message: string) => void
    ): void {
        const myCredits = playerData.credits;

        let queueData = productionApi.getQueueData(queueType);
        if (queueData.status == QueueStatus.Idle) {
            // Start building the decided item.
            if (decision !== undefined) {
                logger(`Decision (${queueTypeToName(queueType)}): ${decision.unit.name}`);
                actionsApi.queueForProduction(queueType, decision.unit.name, decision.unit.type, 1);
            }
        } else if (queueData.status == QueueStatus.Ready && queueData.items.length > 0) {
            // Consider placing it.
            const objectReady: TechnoRules = queueData.items[0].rules;
            if (queueType == QueueType.Structures || queueType == QueueType.Armory) {
                let location: { rx: number; ry: number } | undefined = this.getBestLocationForStructure(
                    game,
                    playerData,
                    objectReady
                );
                if (location !== undefined) {
                    actionsApi.placeBuilding(objectReady.name, location.rx, location.ry);
                }
            }
        } else if (queueData.status == QueueStatus.Active && queueData.items.length > 0 && decision != null) {
            // Consider cancelling if something else is significantly higher priority.
            const current = queueData.items[0].rules;
            const options = productionApi.getAvailableObjects(queueType);
            if (decision.unit != current) {
                // Changing our mind.
                let currentItemPriority = this.getPriorityForBuildingOption(current, game, playerData, threatCache);
                let newItemPriority = decision.priority;
                if (newItemPriority > currentItemPriority * 2) {
                    logger(
                        `Dequeueing queue ${queueTypeToName(queueData.type)} unit ${current.name} because ${
                            decision.unit.name
                        } has 2x higher priority.`
                    );
                    actionsApi.unqueueFromProduction(queueData.type, current.name, current.type, 1);
                }
            } else {
                // Not changing our mind, but maybe other queues are more important for now.
                if (totalCostAcrossQueues > myCredits && decision.priority < totalWeightAcrossQueues * 0.25) {
                    logger(
                        `Pausing queue ${queueTypeToName(queueData.type)} because weight is low (${
                            decision.priority
                        }/${totalWeightAcrossQueues})`
                    );
                    actionsApi.pauseProduction(queueData.type);
                }
            }
        } else if (queueData.status == QueueStatus.OnHold) {
            // Consider resuming queue if priority is high relative to other queues.
            if (myCredits >= totalCostAcrossQueues) {
                logger(`Resuming queue ${queueTypeToName(queueData.type)} because credits are high`);
                actionsApi.resumeProduction(queueData.type);
            } else if (decision && decision.priority >= totalWeightAcrossQueues * 0.25) {
                logger(
                    `Resuming queue ${queueTypeToName(queueData.type)} because weight is high (${
                        decision.priority
                    }/${totalWeightAcrossQueues})`
                );
                actionsApi.resumeProduction(queueData.type);
            }
        }
    }

    private getBestOptionForBuilding(
        game: GameApi,
        options: TechnoRules[],
        threatCache: GlobalThreat | undefined,
        playerData: PlayerData,
        debug: boolean = false,
        logger: (message: string) => void
    ): TechnoRulesWithPriority | undefined {
        let priorityQueue: TechnoRulesWithPriority[] = [];
        options.forEach((option) => {
            let priority = this.getPriorityForBuildingOption(option, game, playerData, threatCache);
            if (priority > 0) {
                priorityQueue.push({ unit: option, priority: priority });
            }
        });

        priorityQueue = priorityQueue.sort((a, b) => {
            return a.priority - b.priority;
        });
        if (priorityQueue.length > 0) {
            const lastItem = priorityQueue[priorityQueue.length - 1];
            if (debug) {
                let queueString = priorityQueue.map((item) => item.unit.name + "(" + item.priority + ")").join(", ");
                logger(`Build priority currently: ${queueString}`);
            }
        }

        return priorityQueue.pop();
    }

    private getPriorityForBuildingOption(
        option: TechnoRules,
        game: GameApi,
        playerStatus: PlayerData,
        threatCache: GlobalThreat | undefined
    ) {
        if (BUILDING_NAME_TO_RULES.has(option.name)) {
            let logic = BUILDING_NAME_TO_RULES.get(option.name)!;
            return logic.getPriority(game, playerStatus, option, threatCache);
        } else {
            // Fallback priority when there are no rules.
            return (
                DEFAULT_BUILDING_PRIORITY - game.getVisibleUnits(playerStatus.name, "self", (r) => r == option).length
            );
        }
    }

    private getBestLocationForStructure(
        game: GameApi,
        playerData: PlayerData,
        objectReady: TechnoRules
    ): { rx: number; ry: number } | undefined {
        if (BUILDING_NAME_TO_RULES.has(objectReady.name)) {
            let logic = BUILDING_NAME_TO_RULES.get(objectReady.name)!;
            return logic.getPlacementLocation(game, playerData, objectReady);
        } else {
            // fallback placement logic
            return getDefaultPlacementLocation(game, playerData, playerData.startLocation, objectReady);
        }
    }
}
