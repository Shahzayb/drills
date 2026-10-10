import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthReport, HealthService } from './health.service';
import type { LivenessReport } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** Readiness: what the load balancer routes on. */
  @Get()
  async ready(): Promise<HealthReport> {
    return this.answer(await this.healthService.ready());
  }

  @Get('deps')
  async deps(): Promise<HealthReport> {
    return this.answer(await this.healthService.deps());
  }

  @Get('live')
  live(): LivenessReport {
    return this.healthService.live();
  }

  private answer(report: HealthReport): HealthReport {
    // Passing an object makes it the entire response body, so the 503 carries
    // the same shape as the 200 instead of Nest's default error envelope.
    if (report.status !== 'ok') throw new ServiceUnavailableException(report);
    return report;
  }
}
