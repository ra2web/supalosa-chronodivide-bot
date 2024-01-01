import { GameApi, PlayerData, TechnoRules, Vector2 } from "@chronodivide/game-api";
import { getPointTowardsOtherPoint } from "../map/map.js";
import { GlobalThreat } from "../threat/threat.js";
import { AiBuildingRules, getDefaultPlacementLocation, numBuildingsOwnedOfType } from "./buildingRules.js";

export class AntiGroundStaticDefence implements AiBuildingRules {
    constructor(
        private basePriority: number,
        private baseAmount: number,
        private groundStrength: number,
    ) {}

    getPlacementLocation(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
    ): { rx: number; ry: number } | undefined {
        // Prefer front towards enemy.
        let startLocation = playerData.startLocation;
        let players = game.getPlayers();
        let enemyFacingLocationCandidates: Vector2[] = [];
        for (let i = 0; i < players.length; ++i) {
            let playerName = players[i];
            if (playerName == playerData.name) {
                continue;
            }
            let enemyPlayer = game.getPlayerData(playerName);
            enemyFacingLocationCandidates.push(
                getPointTowardsOtherPoint(game, startLocation, enemyPlayer.startLocation, 4, 16, 1.5),
            );
        }
        let selectedLocation =
            enemyFacingLocationCandidates[Math.floor(game.generateRandom() * enemyFacingLocationCandidates.length)];
        return getDefaultPlacementLocation(game, playerData, selectedLocation, technoRules, false, 0);
    }

    getPriority(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number {
        // If the enemy's ground power is increasing we should try to keep up.
        if (threatCache) {
            let denominator =
                threatCache.totalAvailableAntiGroundFirepower + threatCache.totalDefensivePower + this.groundStrength;
            if (threatCache.totalOffensiveLandThreat > denominator * 1.1) {
                return this.basePriority * (threatCache.totalOffensiveLandThreat / Math.max(1, denominator));
            } else {
                return 0;
            }
        }
        const strengthPerCost = (this.groundStrength / technoRules.cost) * 1000;
        const numOwned = numBuildingsOwnedOfType(game, playerData, technoRules);
        return this.basePriority * (1.0 - numOwned / this.baseAmount) * strengthPerCost;
    }

    getMaxCount(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number | null {
        return null;
    }
}
