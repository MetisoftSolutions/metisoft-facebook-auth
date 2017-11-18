import { Request, Response, NextFunction } from 'express';
import metisoftDatabaseUtil = require('metisoft-database-util');



declare function config(
  databaseConfig: metisoftDatabaseUtil.ConnectionConfig
): void;

declare function facebookAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void;