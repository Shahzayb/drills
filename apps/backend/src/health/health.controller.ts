import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthReport, HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async check(): Promise<HealthReport> {
    const report = await this.healthService.check();

    if (report.status === 'error') {
      // Passing an object makes it the entire response body, so the 503 carries
      // the same shape as the 200 instead of Nest's default error envelope.
      throw new ServiceUnavailableException(report);
    }

    return report;
  }
}
