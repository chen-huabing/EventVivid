import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { name: 'EventVivid API', status: 'ok', time: new Date().toISOString() };
  }
}
