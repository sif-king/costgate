// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

import { Router } from 'express';
import { handleModelsList } from '../handlers/modelsHandler.js';

export const router = Router();
router.get('/', handleModelsList);
