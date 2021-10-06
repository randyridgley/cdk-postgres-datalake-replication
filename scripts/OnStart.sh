#!/bin/bash
set -e
sudo -i -u ec2-user bash << EOF
echo "Install libs"
pip install psycopg2-binary