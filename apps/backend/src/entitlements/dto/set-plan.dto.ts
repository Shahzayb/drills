import { IsIn } from 'class-validator';
import { PLANS } from '../entitlements.service';
import type { Plan } from '../entitlements.service';

export class SetPlanDto {
  @IsIn(PLANS)
  plan!: Plan;
}
