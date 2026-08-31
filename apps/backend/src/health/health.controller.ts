import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthReport, HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async check(): Promise<HealthReport> {
    const report = await this.healthService.check();

    if (report.status === 'error') {
      throw new ServiceUnavailableException(report);
    }

    return report;
  }
}
